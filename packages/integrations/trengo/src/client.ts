// Trengo HTTP client.
//
// Per CLAUDE.md §11 each agent uses their OWN Trengo API token so outbound
// messages preserve agent identity. Tokens are KMS-encrypted at rest and
// decrypted just-in-time inside this factory. Expired tokens fail closed
// with BusinessError('TOKEN_EXPIRED'); we never fall back to a shared
// service token — that would break attribution.

import { BusinessError } from '@studymind/core'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
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

/** A media (file) message on a ticket — Trengo's documented
 *  `POST /tickets/:id/messages/media` (multipart `file`). One file per
 *  message, the way Trengo's own composer sends attachments. */
export interface TrengoSendMediaInput {
  ticketId: number
  filename: string
  contentType: string
  data: Buffer
}

export interface TrengoMediaResource {
  id: number
}

/** A file to upload to Trengo before attaching to a message. */
export interface TrengoUploadInput {
  filename: string
  contentType: string
  data: Buffer
}

/** Start a brand-new conversation (first outbound to a contact). */
export interface TrengoCreateConversationInput {
  channel: 'whatsapp' | 'sms' | 'email' | 'web_chat'
  /** E.164 phone for whatsapp/sms; email address for email. */
  recipient: string
  body: string
  customFields?: Record<string, string>
  /** Exact Trengo channel (sender line/mailbox) to send from. Workspaces run
   *  several channels per type (Study Mind Support, MM ANZ, …) — without this
   *  the fallback chain picked the FIRST matching type, i.e. an arbitrary
   *  sender identity. */
  channelId?: number
}

/** Our channel kind → Trengo's channel `type` tag (GET /channels). */
const CHANNEL_TYPE_FOR: Record<TrengoCreateConversationInput['channel'], string> = {
  whatsapp: 'WA_BUSINESS',
  sms: 'SMS',
  email: 'EMAIL',
  web_chat: 'CHAT',
}

export interface TrengoCreateConversationResult {
  ticketId: number
  messageId: number | null
}

export interface TrengoMessageResource {
  /** Null when Trengo's response carried no message id (the documented
   *  response is a confirmation like `{"message":"..."}`). */
  id: number | null
  ticket_id: number
  body: string
  direction: 'outbound'
}

export interface TrengoTicketResource {
  id: number
  status: string
}

export interface TrengoLabelResource {
  id: number
  name: string
  color?: string | null
}

/** An approved WhatsApp (HSM) template as Trengo returns it. Field names vary
 *  slightly across Trengo plans/versions, so everything but `id` is optional
 *  and the outbound layer normalises. */
export interface TrengoWaTemplateResource {
  id: number
  title?: string | null
  name?: string | null
  message?: string | null
  body?: string | null
  content?: string | null
  status?: string | null
}

/** Send an approved WhatsApp template (HSM) — starts/refreshes the WhatsApp
 *  session so it works outside the 24-hour customer-service window. */
export interface TrengoSendWaTemplateInput {
  /** E.164 recipient phone. */
  recipientPhone: string
  /** The wa_templates row id (hsm_id). */
  templateId: number
  /** Values for the template's {{n}} placeholders, in order. */
  params: Array<{ key: string; value: string }>
}

export interface TrengoSendWaTemplateResult {
  ticketId: number | null
  messageId: number | null
}

/** A Trengo quick reply (canned response) as the API returns it. Field names
 *  vary across versions, so everything but `id` is optional. */
export interface TrengoQuickReplyResource {
  id: number
  title?: string | null
  name?: string | null
  message?: string | null
  body?: string | null
}

/** A workspace channel (WhatsApp line, SMS sender, mailbox, …). `type` is
 *  Trengo's channel type tag, e.g. WA_BUSINESS | SMS | EMAIL | CHAT. */
export interface TrengoChannelResource {
  id: number
  name?: string | null
  type?: string | null
}

export interface TrengoClient {
  readonly baseUrl: string
  readonly agentId: string
  sendMessage(input: TrengoSendMessageInput): Promise<TrengoMessageResource>
  /** Send one file on a ticket (documented `POST /tickets/:id/messages/media`). */
  sendMediaMessage(input: TrengoSendMediaInput): Promise<TrengoMessageResource>
  assignTicket(ticketId: number, assigneeUserId: number): Promise<TrengoTicketResource>
  closeTicket(ticketId: number): Promise<TrengoTicketResource>
  reopenTicket(ticketId: number): Promise<TrengoTicketResource>
  /** Label (tag) catalogue + per-ticket attach/detach. CLAUDE.md §11. */
  listLabels(): Promise<TrengoLabelResource[]>
  createLabel(name: string): Promise<TrengoLabelResource>
  attachLabel(ticketId: number, labelId: number): Promise<void>
  detachLabel(ticketId: number, labelId: number): Promise<void>
  /** Internal (team-only) note on a ticket — never sent to the customer. */
  addInternalNote(ticketId: number, body: string): Promise<{ id: number }>
  /** Upload a file to Trengo, returning the media id to attach to a message. */
  uploadMedia(input: TrengoUploadInput): Promise<TrengoMediaResource>
  /** Start a brand-new conversation (create a ticket + send the first
   *  outbound message). CLAUDE.md §11. */
  createConversation(
    input: TrengoCreateConversationInput,
  ): Promise<TrengoCreateConversationResult>
  /** The workspace's approved WhatsApp (HSM) templates. */
  listWaTemplates(): Promise<TrengoWaTemplateResource[]>
  /** Send an approved WhatsApp template via /wa_sessions (valid outside the
   *  24-hour window — the same thing the Trengo UI does). */
  sendWaTemplate(input: TrengoSendWaTemplateInput): Promise<TrengoSendWaTemplateResult>
  /** The workspace's quick replies (canned responses) — the SMS "templates". */
  listQuickReplies(): Promise<TrengoQuickReplyResource[]>
  /** The workspace's channels (WhatsApp lines, SMS senders, mailboxes). */
  listChannels(): Promise<TrengoChannelResource[]>
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
  const fetchImpl = opts.fetchImpl ?? safeFetch

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
    // Parse AFTER the ok-check decision: a 429/5xx often carries an HTML
    // body, and JSON.parse throwing first would surface as a SyntaxError
    // instead of a typed TrengoApiError (breaking every caller's status
    // handling). Non-JSON bodies on errors are preserved as raw text.
    if (!res.ok) {
      let errBody: unknown = null
      try {
        errBody = text ? (JSON.parse(text) as unknown) : null
      } catch {
        errBody = text
      }
      throw new TrengoApiError(res.status, path, errBody)
    }
    const parsed = text ? (JSON.parse(text) as unknown) : null
    return parsed as T
  }

  // Hoisted so createConversation's fallback chain can reuse them without
  // relying on `this` inside the returned literal.
  /**
   * Normalise the send-message response. The documented response is a plain
   * confirmation (`{"message":"…"}` — a STRING, no id); some workspaces
   * return the created row under `message` / `data` / the root. The old code
   * assumed `{ message: { id } }` and crashed reading `.id` off a string.
   */
  function normaliseSentMessage(res: unknown, ticketId: number): TrengoMessageResource {
    const root = (res ?? {}) as Record<string, unknown>
    const msg = root['message']
    const candidate =
      msg !== null && typeof msg === 'object'
        ? (msg as Record<string, unknown>)
        : ((root['data'] ?? root) as Record<string, unknown>)
    return {
      id: typeof candidate['id'] === 'number' ? candidate['id'] : null,
      ticket_id:
        typeof candidate['ticket_id'] === 'number'
          ? (candidate['ticket_id'] as number)
          : ticketId,
      body: typeof candidate['body'] === 'string' ? (candidate['body'] as string) : '',
      direction: 'outbound',
    }
  }

  async function sendMessageImpl(
    input: TrengoSendMessageInput,
  ): Promise<TrengoMessageResource> {
    // THE field Trengo's documented endpoint validates is `message`
    // (developers.trengo.com/reference/send-a-message) — sending only `body`
    // was rejected as "message required" and every reply 422'd. `body` rides
    // along for any older workspace that accepted the legacy shape; unknown
    // fields are ignored.
    const res = await request<unknown>('POST', `/tickets/${input.ticketId}/messages`, {
      message: input.body,
      body: input.body,
      channel: input.channel,
      custom_fields: input.customFields ?? {},
    })
    return normaliseSentMessage(res, input.ticketId)
  }

  async function sendMediaMessageImpl(
    input: TrengoSendMediaInput,
  ): Promise<TrengoMessageResource> {
    // Documented `POST /tickets/:id/messages/media` — multipart `file`, one
    // file per message (developers.trengo.com/reference/send-media). The old
    // upload-to-/media-then-attachment_ids flow was never a documented shape.
    const form = new FormData()
    const blob = new Blob([input.data as unknown as BlobPart], {
      type: input.contentType,
    })
    form.append('file', blob, input.filename)
    const res = await fetchImpl(`${baseUrl}/tickets/${input.ticketId}/messages/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: form,
    })
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
      throw new TrengoApiError(res.status, `/tickets/${input.ticketId}/messages/media`, parsed)
    }
    return normaliseSentMessage(parsed, input.ticketId)
  }

  async function listChannelsImpl(): Promise<TrengoChannelResource[]> {
    const res = await request<{ data?: TrengoChannelResource[] }>('GET', '/channels')
    return res.data ?? []
  }

  return {
    baseUrl,
    agentId: opts.agentId,
    request,
    sendMessage: sendMessageImpl,
    sendMediaMessage: sendMediaMessageImpl,
    async assignTicket(ticketId, assigneeUserId) {
      // Documented as POST with { type, user_id }
      // (developers.trengo.com/reference/assign-a-ticket). The old PATCH +
      // bare user_id silently failed, so "Assign" never took.
      const res = await request<{ ticket?: TrengoTicketResource } & Partial<TrengoTicketResource>>(
        'POST',
        `/tickets/${ticketId}/assign`,
        { type: 'user', user_id: assigneeUserId },
      )
      return res.ticket ?? { id: ticketId, status: (res.status as string) ?? 'assigned' }
    },
    async closeTicket(ticketId) {
      // POST, not PATCH (developers.trengo.com/reference/close-a-ticket) —
      // THE close-button bug. The response is a confirmation, not always a
      // ticket object, so parse defensively.
      const res = await request<{ ticket?: TrengoTicketResource } & Partial<TrengoTicketResource>>(
        'POST',
        `/tickets/${ticketId}/close`,
      )
      return res.ticket ?? { id: ticketId, status: (res.status as string) ?? 'closed' }
    },
    async reopenTicket(ticketId) {
      // POST, not PATCH (developers.trengo.com/reference/reopen-a-ticket).
      const res = await request<{ ticket?: TrengoTicketResource } & Partial<TrengoTicketResource>>(
        'POST',
        `/tickets/${ticketId}/reopen`,
      )
      return res.ticket ?? { id: ticketId, status: (res.status as string) ?? 'open' }
    },
    async listLabels() {
      // Trengo paginates labels; one page (default) is plenty for an ops
      // team's tag catalogue. The response wraps rows under `data`.
      const res = await request<{ data?: TrengoLabelResource[] }>('GET', '/labels')
      return res.data ?? []
    },
    async createLabel(name) {
      const res = await request<
        { data?: TrengoLabelResource } & Partial<TrengoLabelResource>
      >('POST', '/labels', { name })
      const row = res.data ?? (res as TrengoLabelResource)
      return { id: row.id, name: row.name, color: row.color ?? null }
    },
    async attachLabel(ticketId, labelId) {
      await request('POST', `/tickets/${ticketId}/labels`, { label_id: labelId })
    },
    async detachLabel(ticketId, labelId) {
      await request('DELETE', `/tickets/${ticketId}/labels/${labelId}`)
    },
    async addInternalNote(ticketId, body) {
      // Internal notes are team-only — they are NOT delivered to the
      // customer. Trengo exposes them under the ticket /notes collection.
      const res = await request<{ data?: { id: number }; id?: number }>(
        'POST',
        `/tickets/${ticketId}/notes`,
        // Both spellings — Trengo versions disagree on the param name and
        // ignore the one they don't validate.
        { note: body, body },
      )
      return { id: res.data?.id ?? res.id ?? 0 }
    },
    async uploadMedia(input) {
      // Multipart upload — we drive fetch directly (not `request`, which is
      // JSON) so the boundary header is set automatically. Trengo returns the
      // created media under `data` (or at the top level on some versions).
      const form = new FormData()
      // Buffer is a Uint8Array, but TS's BlobPart union trips on the
      // SharedArrayBuffer case — cast through BlobPart.
      const blob = new Blob([input.data as unknown as BlobPart], {
        type: input.contentType,
      })
      form.append('file', blob, input.filename)
      const res = await fetchImpl(`${baseUrl}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        body: form,
      })
      const text = await res.text()
      const parsed = text ? (JSON.parse(text) as unknown) : null
      if (!res.ok) throw new TrengoApiError(res.status, '/media', parsed)
      const row = (parsed as { data?: TrengoMediaResource } & Partial<TrengoMediaResource>)
      const media = row.data ?? (row as TrengoMediaResource)
      return { id: media.id }
    },
    async createConversation(input) {
      // Start a new conversation. Two strategies, in order:
      //
      //  (1) POST /messages with our compact shape. Some Trengo versions
      //      accept this directly.
      //  (2) The documented chain when (1) is rejected with a 4xx: resolve the
      //      workspace channel (GET /channels), upsert the channel contact by
      //      identifier (POST /channels/{id}/contacts — Trengo upserts on the
      //      identifier so this never duplicates), create the ticket
      //      (POST /tickets {channel_id, contact_id}), then send the first
      //      message on it (POST /tickets/{id}/messages — the same documented
      //      endpoint every reply already uses).
      //
      // Both are kept here so a correction is local; the chain endpoints are
      // pinned by client.test.ts and listed in the README's assumed table.
      try {
        const res = await request<{
          ticket?: { id: number }
          message?: { id: number; ticket_id?: number }
          data?: { ticket_id?: number; id?: number }
        }>('POST', '/messages', {
          channel: input.channel,
          ...(input.channelId ? { channel_id: input.channelId } : {}),
          recipient: input.recipient,
          body: input.body,
          custom_fields: input.customFields ?? {},
        })
        const ticketId =
          res.ticket?.id ?? res.message?.ticket_id ?? res.data?.ticket_id ?? 0
        const messageId = res.message?.id ?? res.data?.id ?? null
        if (ticketId) return { ticketId, messageId }
        // Accepted but no ticket id → fall through to the explicit chain.
      } catch (err) {
        // Only fall back on a client-side rejection (wrong shape / unknown
        // route). 5xx / auth problems propagate — retrying a different shape
        // would not help and hides the real error.
        const status = err instanceof TrengoApiError ? err.status : 0
        if (!(status >= 400 && status < 500)) throw err
      }

      // (2) Documented chain.
      const channels = await listChannelsImpl()
      const wanted = CHANNEL_TYPE_FOR[input.channel]
      const channelRow = input.channelId
        ? { id: input.channelId }
        : (channels.find((c) => (c.type ?? '').toUpperCase() === wanted) ??
          channels.find((c) => (c.type ?? '').toUpperCase().includes(wanted)))
      if (!channelRow) {
        throw new TrengoApiError(404, '/channels', {
          reason: `No ${input.channel} channel found in the Trengo workspace`,
        })
      }

      const contactRes = await request<{
        data?: { id?: number }
        id?: number
      }>('POST', `/channels/${channelRow.id}/contacts`, {
        identifier: input.recipient,
      })
      const trengoContactId = contactRes.data?.id ?? contactRes.id
      if (!trengoContactId) {
        throw new TrengoApiError(502, `/channels/${channelRow.id}/contacts`, {
          reason: 'no contact id returned',
        })
      }

      const ticketRes = await request<{
        data?: { id?: number }
        ticket?: { id?: number }
        id?: number
      }>('POST', '/tickets', {
        channel_id: channelRow.id,
        contact_id: trengoContactId,
      })
      const ticketId = ticketRes.data?.id ?? ticketRes.ticket?.id ?? ticketRes.id
      if (!ticketId) {
        throw new TrengoApiError(502, '/tickets', { reason: 'no ticket id returned' })
      }

      const message = await sendMessageImpl({
        ticketId,
        body: input.body,
        channel: input.channel,
        ...(input.customFields ? { customFields: input.customFields } : {}),
      })
      return { ticketId, messageId: message.id ?? null }
    },
    async listWaTemplates() {
      // Trengo paginates; one page covers an ops team's approved templates.
      // Rows come wrapped under `data`.
      const res = await request<{ data?: TrengoWaTemplateResource[] }>(
        'GET',
        '/wa_templates',
      )
      return res.data ?? []
    },
    async sendWaTemplate(input) {
      // POST /wa_sessions starts (or refreshes) a WhatsApp session with an
      // approved HSM template — the only way to message outside the 24-hour
      // window. Params are keyed "{{1}}", "{{2}}", … exactly as Trengo's own
      // composer sends them. Response shape varies by version; parse
      // defensively like createConversation.
      const res = await request<{
        ticket?: { id: number }
        message?: { id: number; ticket_id?: number }
        data?: { ticket_id?: number; id?: number }
      }>('POST', '/wa_sessions', {
        recipient_phone_number: input.recipientPhone,
        hsm_id: input.templateId,
        params: input.params.map((p) => ({ key: p.key, value: p.value })),
      })
      const ticketId =
        res.ticket?.id ?? res.message?.ticket_id ?? res.data?.ticket_id ?? null
      const messageId = res.message?.id ?? res.data?.id ?? null
      return { ticketId, messageId }
    },
    async listQuickReplies() {
      // Trengo's canned responses — surfaced as the SMS "templates". Rows come
      // wrapped under `data`; one page covers an ops team's catalogue.
      const res = await request<{ data?: TrengoQuickReplyResource[] }>(
        'GET',
        '/quick_replies',
      )
      return res.data ?? []
    },
    listChannels: listChannelsImpl,
  }
}
