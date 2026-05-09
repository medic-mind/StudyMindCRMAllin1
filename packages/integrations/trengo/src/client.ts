// Trengo HTTP client.
//
// Per CLAUDE.md §11 each agent uses their OWN Trengo API token so outbound
// messages preserve agent identity. Tokens are KMS-encrypted at rest and
// decrypted just-in-time inside this factory. Expired tokens fail closed
// with BusinessError('TOKEN_EXPIRED'); we never fall back to a shared
// service token — that would break attribution.

import { BusinessError } from '@studymind/core'
import { decryptField } from '@studymind/core/safeguarding'
import { db } from '@studymind/db'

export const TRENGO_API_BASE = 'https://app.trengo.com/api/v2' as const

export interface TrengoSendMessageInput {
  ticketId: number
  body: string
  channel: 'whatsapp' | 'sms' | 'email' | 'web_chat'
  /** Custom-field metadata that lets us reconcile Trengo events to our
   *  Interaction id. CLAUDE.md §11. */
  customFields?: Record<string, string>
}

export interface TrengoMessageResource {
  id: number
  ticket_id: number
  body: string
  direction: 'outbound'
}

export interface TrengoTicketResource {
  id: number
  status: string
}

export interface TrengoClient {
  readonly baseUrl: string
  readonly agentId: string
  sendMessage(input: TrengoSendMessageInput): Promise<TrengoMessageResource>
  assignTicket(ticketId: number, assigneeUserId: number): Promise<TrengoTicketResource>
  closeTicket(ticketId: number): Promise<TrengoTicketResource>
  request<T>(method: string, path: string, body?: unknown): Promise<T>
}

export class TrengoApiError extends Error {
  override readonly name = 'TrengoApiError'
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Trengo ${status} on ${path}`)
  }
}

export interface CreateTrengoClientOptions {
  agentId: string
  /** Optional override for tests. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Override the looked-up token for tests. Production callers omit this. */
  token?: string
  /** Audit/correlation context for the decryption call. */
  purpose?: string
  requestId?: string
}

/**
 * Build a Trengo client scoped to a single agent. The agent's token is
 * decrypted once at construction time. The returned client is therefore
 * tied to one agent and one request — it MUST NOT be cached across users.
 */
export async function createClientForAgent(
  opts: CreateTrengoClientOptions,
): Promise<TrengoClient> {
  const baseUrl = opts.baseUrl ?? TRENGO_API_BASE
  const fetchImpl = opts.fetchImpl ?? fetch

  let token = opts.token
  if (!token) {
    const row = await db.trengoToken.findUnique({
      where: { agentId: opts.agentId },
      select: {
        tokenCiphertext: true,
        tokenIv: true,
        dekCiphertext: true,
        aad: true,
        keyVersion: true,
        expiresAt: true,
        deletedAt: true,
      },
    })
    if (!row || row.deletedAt) {
      throw new BusinessError('TOKEN_EXPIRED', 'No Trengo token registered for agent', {
        agentId: opts.agentId,
      })
    }
    if (row.expiresAt.getTime() < Date.now()) {
      // CLAUDE.md §11: fail closed; never fall back to a shared token.
      throw new BusinessError('TOKEN_EXPIRED', 'Trengo token has expired for agent', {
        agentId: opts.agentId,
        expiresAt: row.expiresAt.toISOString(),
      })
    }
    token = await decryptField(
      {
        ciphertext: row.tokenCiphertext,
        iv: row.tokenIv,
        dekCiphertext: row.dekCiphertext,
        aad: row.aad,
        keyVersion: row.keyVersion,
      },
      {
        actorId: opts.agentId,
        purpose: opts.purpose ?? 'trengo.outbound',
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      },
    )
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
      throw new TrengoApiError(res.status, path, parsed)
    }
    return parsed as T
  }

  return {
    baseUrl,
    agentId: opts.agentId,
    request,
    async sendMessage(input) {
      const res = await request<{ message: TrengoMessageResource }>(
        'POST',
        `/tickets/${input.ticketId}/messages`,
        {
          body: input.body,
          channel: input.channel,
          custom_fields: input.customFields ?? {},
        },
      )
      return res.message
    },
    async assignTicket(ticketId, assigneeUserId) {
      const res = await request<{ ticket: TrengoTicketResource }>(
        'PATCH',
        `/tickets/${ticketId}/assign`,
        { user_id: assigneeUserId },
      )
      return res.ticket
    },
    async closeTicket(ticketId) {
      const res = await request<{ ticket: TrengoTicketResource }>(
        'PATCH',
        `/tickets/${ticketId}/close`,
      )
      return res.ticket
    },
  }
}
