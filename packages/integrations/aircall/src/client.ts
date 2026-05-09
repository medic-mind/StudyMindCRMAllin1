// Aircall REST client.
//
// We deliberately use direct HTTP (fetch) rather than an SDK:
// - The webhook signature is HMAC-SHA-256 of the raw body (§10), so the SDK
//   is not required for verification.
// - Our needs are narrow (refetch a call, fetch its recording, manage the
//   set of registered webhooks). A thin wrapper keeps the surface auditable.
//
// Auth: Aircall uses HTTP Basic with `(api_id, api_token)`. Both are read
// from env: AIRCALL_API_ID, AIRCALL_API_TOKEN.

export const AIRCALL_API_BASE = 'https://api.aircall.io/v1' as const

export interface AircallCallResource {
  id: number
  direction: 'inbound' | 'outbound'
  status: string
  started_at: number
  answered_at: number | null
  ended_at: number | null
  duration: number
  raw_digits: string
  number?: { id: number; digits: string; name: string }
  contact?: {
    phone_numbers?: { value: string }[]
    emails?: { value: string }[]
  } | null
  recording: string | null
  voicemail: string | null
  transcription?: { content: string; language?: string } | null
}

export interface AircallRecording {
  url: string
  contentType?: string
}

export interface AircallWebhookSummary {
  webhook_id: string
  url: string
  events: string[]
  /** Aircall sets this to true after 10 consecutive failures. */
  disabled?: boolean
  active?: boolean
}

export interface AircallClientOptions {
  apiId?: string
  apiToken?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export interface AircallClient {
  readonly baseUrl: string
  getCall(callId: string | number): Promise<AircallCallResource>
  getRecording(callId: string | number): Promise<AircallRecording>
  listWebhooks(): Promise<AircallWebhookSummary[]>
  enableWebhook(webhookId: string): Promise<AircallWebhookSummary>
  request<T>(method: string, path: string, body?: unknown): Promise<T>
}

let cached: { client: AircallClient; key: string } | null = null

export class AircallApiError extends Error {
  override readonly name = 'AircallApiError'
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Aircall ${status} on ${path}`)
  }
}

export function createClient(opts: AircallClientOptions = {}): AircallClient {
  const apiId = opts.apiId ?? process.env['AIRCALL_API_ID']
  const apiToken = opts.apiToken ?? process.env['AIRCALL_API_TOKEN']
  if (!apiId || !apiToken) {
    throw new Error('AIRCALL_API_ID and AIRCALL_API_TOKEN must be set')
  }
  const baseUrl = opts.baseUrl ?? AIRCALL_API_BASE
  const fetchImpl = opts.fetchImpl ?? fetch
  const isEnvDriven =
    !opts.apiId && !opts.apiToken && !opts.baseUrl && !opts.fetchImpl

  const cacheKey = `${apiId}:${baseUrl}`
  if (isEnvDriven && cached && cached.key === cacheKey) return cached.client

  const auth = Buffer.from(`${apiId}:${apiToken}`).toString('base64')

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
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
      throw new AircallApiError(res.status, path, parsed)
    }
    return parsed as T
  }

  const client: AircallClient = {
    baseUrl,
    request,
    async getCall(callId) {
      const res = await request<{ call: AircallCallResource }>('GET', `/calls/${callId}`)
      return res.call
    },
    async getRecording(callId) {
      const res = await request<{ recording: AircallRecording }>(
        'GET',
        `/calls/${callId}/recording`,
      )
      return res.recording
    },
    async listWebhooks() {
      const res = await request<{ webhooks: AircallWebhookSummary[] }>('GET', `/webhooks`)
      return res.webhooks
    },
    async enableWebhook(webhookId) {
      const res = await request<{ webhook: AircallWebhookSummary }>(
        'PUT',
        `/webhooks/${webhookId}`,
        { active: true },
      )
      return res.webhook
    },
  }

  if (isEnvDriven) cached = { client, key: cacheKey }
  return client
}

/** Reset the cached client. Tests only. */
export function __resetClientForTests(): void {
  cached = null
}
