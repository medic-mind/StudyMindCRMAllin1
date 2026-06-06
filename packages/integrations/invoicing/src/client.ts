// Typed HTTP client for the B2B Invoices Platform REST API
// (b2b.studymind.co.uk/api/v1). One file, tsc-clean.
//
// Auth: `Authorization: Bearer sk_live_…`. 401 = bad/revoked key,
// 403 = read-only key. All outbound goes through safeFetch (SSRF allowlist,
// CLAUDE.md §44.2). Field names are VERBATIM from the API contract.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import {
  EventsFeedResponse,
  RawBankAccount,
  RawBillingCompany,
  RawCompanySettings,
  RawCustomer,
  RawCustomerContact,
  RawEvent,
  RawInvoice,
  RawInvoiceActivity,
  RawPayment,
  type ListResponse,
} from './types'

export class InvoicingApiError extends Error {
  override readonly name: string = 'InvoicingApiError'
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Invoicing API ${status} on ${path}`)
  }
}

/** Thrown when the API key is read-only (403) — outbound writes must surface
 *  this distinctly so the UI can tell the user to request a read+write key. */
export class InvoicingReadOnlyError extends InvoicingApiError {
  override readonly name = 'InvoicingReadOnlyError'
}

/** Thrown when the key is missing/invalid (401). */
export class InvoicingUnauthorizedError extends InvoicingApiError {
  override readonly name = 'InvoicingUnauthorizedError'
}

export interface InvoicingClientOptions {
  apiKey: string
  baseUrl: string
  fetchImpl?: typeof fetch
}

// --- Write payload shapes (verbatim field names) -----------------------------

export interface CustomerWritePayload {
  company_name?: string
  contact_name?: string
  contact_email?: string
  contact_email_cc?: string
  phone?: string
  address?: string
  country?: string
  vat_number?: string
  status?: 'active' | 'on_hold' | 'archived'
  tags?: string[]
  notes?: string
  service?: string
  category?: 'b2b' | 'b2c' | 'alt_provision'
}

export interface LineItemWritePayload {
  description: string
  quantity: number
  unit_price: number
  vat_rate?: number
}

export interface InvoiceWritePayload {
  partner_id: string
  status?: 'draft' | 'issued' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled'
  issue_date?: string
  due_date?: string
  currency?: string
  payment_terms?: string
  notes?: string
  internal_notes?: string
  bill_to_name?: string
  from_email?: string
  payment_reference?: string
  billing_company_id?: string
  client_type?: 'uk_b2b' | 'school' | 'summer_school' | 'international' | 'alt_provision'
  prices_include_vat?: boolean
  bank_account_id?: string
  po_number?: string
  line_items?: LineItemWritePayload[]
}

export interface PaymentWritePayload {
  amount: number
  /** YYYY-MM-DD. Defaults to "today" on the platform when omitted. */
  payment_date?: string
  method?: string
  reference?: string
}

export interface SendInvoicePayload {
  to?: string
  cc?: string
  subject?: string
  body?: string
  from_email?: string
  from_name?: string
}

export interface SendInvoiceResult {
  sent: boolean
  to: string
  attached_pdf: boolean
  message_id: string
}

export interface SendReminderPayload {
  to?: string
  cc?: string
  subject?: string
  body?: string
  attach_pdf?: boolean
}

export interface SendReminderResult {
  sent: boolean
  to: string
  log_id?: string
}

export interface ReissuePayload {
  /** Fresh issue date (YYYY-MM-DD). Omit to use today on the platform. */
  issue_date?: string
}

/** `GET /invoices/:id/pdf` JSON form — base64-encoded PDF + metadata. */
export interface InvoicePdfJson {
  invoice_number: string
  filename: string
  content_type: string
  base64: string
}

/** `GET /invoices/:id/pdf?format=pdf` binary form — the raw bytes for an
 *  inline preview / download proxy. */
export interface InvoicePdfBytes {
  bytes: ArrayBuffer
  contentType: string
  filename: string
}

/** The platform's rendered email for an invoice (initial send or reminder), so
 *  the CRM can prefill the compose box with the exact wording — staff never
 *  retype, and an un-edited send goes out byte-for-byte as the platform's
 *  template. Shape is permissive; the platform owns the fields. */
export interface InvoiceEmailPreview {
  to?: string
  cc?: string
  subject?: string
  body?: string
  html?: string
  from_email?: string
  from_name?: string
}

export interface RegisterWebhookPayload {
  url: string
  event_types: string[]
}

export interface RegisterWebhookResult {
  id: string
  url: string
  secret: string
  event_types: string[]
}

export interface ListCustomersQuery {
  category?: 'b2b' | 'b2c' | 'alt_provision'
  status?: 'active' | 'on_hold' | 'archived'
  search?: string
  page?: number
  page_size?: number
  since?: string
}

export interface ListInvoicesQuery {
  status?: string
  partner_id?: string
  page?: number
  page_size?: number
  since?: string
}

export interface RootInfo {
  name?: string
  version?: string
  scopes?: string[]
  [key: string]: unknown
}

export interface InvoicingClient {
  readonly baseUrl: string
  /** GET /api/v1/ — connection check; returns name/version/scopes. */
  root(): Promise<RootInfo>
  listCustomers(query?: ListCustomersQuery): Promise<ListResponse<RawCustomer>>
  getCustomer(id: string): Promise<RawCustomer>
  getCustomerContacts(id: string): Promise<RawCustomerContact[]>
  createCustomer(payload: CustomerWritePayload): Promise<RawCustomer>
  updateCustomer(id: string, payload: CustomerWritePayload): Promise<RawCustomer>
  archiveCustomer(id: string): Promise<void>
  listInvoices(query?: ListInvoicesQuery): Promise<ListResponse<RawInvoice>>
  getInvoice(id: string): Promise<RawInvoice>
  createInvoice(payload: InvoiceWritePayload): Promise<RawInvoice>
  updateInvoice(id: string, payload: Partial<InvoiceWritePayload>): Promise<RawInvoice>
  issueInvoice(id: string): Promise<RawInvoice>
  cancelInvoice(id: string): Promise<RawInvoice>
  reissueInvoice(id: string, payload?: ReissuePayload): Promise<RawInvoice>
  duplicateInvoice(id: string): Promise<RawInvoice>
  getInvoiceActivity(id: string): Promise<RawInvoiceActivity[]>
  listPayments(invoiceId: string): Promise<RawPayment[]>
  recordPayment(invoiceId: string, payload: PaymentWritePayload): Promise<unknown>
  deletePayment(invoiceId: string, paymentId: string): Promise<void>
  markPaid(invoiceId: string): Promise<RawInvoice>
  sendInvoice(invoiceId: string, payload?: SendInvoicePayload): Promise<SendInvoiceResult>
  sendReminder(invoiceId: string, payload?: SendReminderPayload): Promise<SendReminderResult>
  /** The platform's rendered email template for this invoice. `kind` selects the
   *  initial send vs the reminder copy. Returns null when the platform exposes
   *  no preview (so the compose box falls back to its own defaults). */
  getInvoiceEmailPreview(
    invoiceId: string,
    kind: 'send' | 'reminder',
  ): Promise<InvoiceEmailPreview | null>
  getInvoicePdfJson(invoiceId: string): Promise<InvoicePdfJson>
  getInvoicePdfBytes(
    invoiceId: string,
    opts?: { disposition?: 'inline' | 'attachment' },
  ): Promise<InvoicePdfBytes>
  getBillingCompanies(): Promise<RawBillingCompany[]>
  getBankAccounts(): Promise<RawBankAccount[]>
  getCompanySettings(): Promise<RawCompanySettings>
  getEvents(since: string, opts?: { limit?: number; type?: string }): Promise<EventsFeedResponse>
  /** Long-lived SSE stream of events. Yields each event as it arrives. The
   *  caller owns the loop + reconnect; pass an AbortSignal to stop. */
  streamEvents(opts?: { since?: string; signal?: AbortSignal }): AsyncGenerator<RawEvent>
  registerWebhook(payload: RegisterWebhookPayload): Promise<RegisterWebhookResult>
  listWebhooks(): Promise<RegisterWebhookResult[]>
  deleteWebhook(id: string): Promise<void>
}

/**
 * Parse one SSE frame ("event: …\nid: …\ndata: {json}") into a RawEvent. The
 * platform sends the same envelope shape as the webhook + events feed, so we
 * reuse RawEvent. Returns null for heartbeats (": hb") and unparseable frames.
 */
export function parseSseEvent(block: string): RawEvent | null {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue // comment / heartbeat
    if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart())
  }
  if (dataLines.length === 0) return null
  try {
    const parsed = RawEvent.safeParse(JSON.parse(dataLines.join('\n')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Build a client bound to one API key + base URL. Not cached — the key is
 * loaded per request from encrypted config (config.ts), so callers construct
 * one when they need it.
 */
export function createClient(opts: InvoicingClientOptions): InvoicingClient {
  const fetchImpl = opts.fetchImpl ?? safeFetch
  const apiBase = `${opts.baseUrl.replace(/\/$/, '')}/api/v1`

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    const text = await res.text()
    const parsed: unknown = text ? safeJsonParse(text) : null

    if (res.status === 401) throw new InvoicingUnauthorizedError(401, path, parsed)
    if (res.status === 403) throw new InvoicingReadOnlyError(403, path, parsed)
    if (!res.ok) throw new InvoicingApiError(res.status, path, parsed)

    return parsed as T
  }

  /** Raw request that returns the Response untouched — used for binary bodies
   *  (the invoice PDF) where we must not JSON-parse. Same auth + error mapping. */
  async function requestRaw(method: string, path: string, accept: string): Promise<Response> {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: accept },
    })
    if (res.status === 401) throw new InvoicingUnauthorizedError(401, path, null)
    if (res.status === 403) throw new InvoicingReadOnlyError(403, path, null)
    if (!res.ok) throw new InvoicingApiError(res.status, path, null)
    return res
  }

  function buildQuery(params: Record<string, string | number | undefined>): string {
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') usp.set(k, String(v))
    }
    const s = usp.toString()
    return s ? `?${s}` : ''
  }

  /** Unwrap `{ data: ... }` envelopes the write endpoints return. */
  function unwrap<T>(value: unknown): T {
    if (value && typeof value === 'object' && 'data' in value) {
      return (value as { data: T }).data
    }
    return value as T
  }

  /** Unwrap a list payload that may be a bare array or a `{ data: [...] }`
   *  envelope, and validate each row with the given Zod schema. */
  function unwrapArray<T>(value: unknown, schema: { parse(v: unknown): T }): T[] {
    const arr = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
        ? ((value as { data: unknown[] }).data)
        : []
    return arr.map((row) => schema.parse(row))
  }

  function filenameFromDisposition(header: string | null, fallback: string): string {
    if (!header) return fallback
    const star = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
    if (star?.[1]) return decodeURIComponent(star[1])
    const plain = /filename="?([^";]+)"?/i.exec(header)
    return plain?.[1] ?? fallback
  }

  return {
    baseUrl: opts.baseUrl,

    async root() {
      return request<RootInfo>('GET', '/')
    },

    async listCustomers(query = {}) {
      const qs = buildQuery({
        category: query.category,
        status: query.status,
        search: query.search,
        page: query.page,
        page_size: query.page_size,
        since: query.since,
      })
      return request<ListResponse<RawCustomer>>('GET', `/customers${qs}`)
    },

    async getCustomer(id) {
      return unwrap<RawCustomer>(await request('GET', `/customers/${id}`))
    },

    async getCustomerContacts(id) {
      return unwrapArray(await request('GET', `/customers/${id}/contacts`), RawCustomerContact)
    },

    async createCustomer(payload) {
      return unwrap<RawCustomer>(await request('POST', '/customers', payload))
    },

    async updateCustomer(id, payload) {
      return unwrap<RawCustomer>(await request('PATCH', `/customers/${id}`, payload))
    },

    async archiveCustomer(id) {
      await request('DELETE', `/customers/${id}`)
    },

    async listInvoices(query = {}) {
      const qs = buildQuery({
        status: query.status,
        partner_id: query.partner_id,
        page: query.page,
        page_size: query.page_size,
        since: query.since,
      })
      return request<ListResponse<RawInvoice>>('GET', `/invoices${qs}`)
    },

    async getInvoice(id) {
      return unwrap<RawInvoice>(await request('GET', `/invoices/${id}`))
    },

    async createInvoice(payload) {
      return unwrap<RawInvoice>(await request('POST', '/invoices', payload))
    },

    async updateInvoice(id, payload) {
      return unwrap<RawInvoice>(await request('PATCH', `/invoices/${id}`, payload))
    },

    async issueInvoice(id) {
      return unwrap<RawInvoice>(await request('POST', `/invoices/${id}/issue`))
    },

    async cancelInvoice(id) {
      return unwrap<RawInvoice>(await request('POST', `/invoices/${id}/cancel`))
    },

    async reissueInvoice(id, payload = {}) {
      return unwrap<RawInvoice>(
        await request(
          'POST',
          `/invoices/${id}/reissue`,
          payload.issue_date ? { issue_date: payload.issue_date } : {},
        ),
      )
    },

    async duplicateInvoice(id) {
      return unwrap<RawInvoice>(await request('POST', `/invoices/${id}/duplicate`))
    },

    async getInvoiceActivity(id) {
      return unwrapArray(await request('GET', `/invoices/${id}/activity`), RawInvoiceActivity)
    },

    async listPayments(invoiceId) {
      return unwrapArray(await request('GET', `/invoices/${invoiceId}/payments`), RawPayment)
    },

    async recordPayment(invoiceId, payload) {
      return request('POST', `/invoices/${invoiceId}/payments`, payload)
    },

    async deletePayment(invoiceId, paymentId) {
      await request('DELETE', `/invoices/${invoiceId}/payments/${paymentId}`)
    },

    async markPaid(invoiceId) {
      return unwrap<RawInvoice>(await request('POST', `/invoices/${invoiceId}/mark-paid`))
    },

    async sendInvoice(invoiceId, payload = {}) {
      return unwrap<SendInvoiceResult>(
        await request('POST', `/invoices/${invoiceId}/send`, payload),
      )
    },

    async sendReminder(invoiceId, payload = {}) {
      return unwrap<SendReminderResult>(
        await request('POST', `/invoices/${invoiceId}/send-reminder`, payload),
      )
    },

    async getInvoiceEmailPreview(invoiceId, kind) {
      // Assumed endpoint (documented in the README); the platform renders the
      // same template Send/Reminder use. Fail SOFT — a missing/!=200 preview
      // returns null so the compose box just falls back to the platform default
      // on send (never breaks the modal). Auth errors (401/403) still surface.
      try {
        const qs = buildQuery({ type: kind })
        return unwrap<InvoiceEmailPreview>(
          await request('GET', `/invoices/${invoiceId}/email-preview${qs}`),
        )
      } catch (err) {
        if (
          err instanceof InvoicingApiError &&
          !(err instanceof InvoicingUnauthorizedError) &&
          !(err instanceof InvoicingReadOnlyError)
        ) {
          return null
        }
        throw err
      }
    },

    async getInvoicePdfJson(invoiceId) {
      return unwrap<InvoicePdfJson>(await request('GET', `/invoices/${invoiceId}/pdf`))
    },

    async getInvoicePdfBytes(invoiceId, opts2 = {}) {
      const qs = buildQuery({ format: 'pdf', disposition: opts2.disposition })
      const res = await requestRaw('GET', `/invoices/${invoiceId}/pdf${qs}`, 'application/pdf')
      const bytes = await res.arrayBuffer()
      return {
        bytes,
        contentType: res.headers.get('content-type') ?? 'application/pdf',
        filename: filenameFromDisposition(
          res.headers.get('content-disposition'),
          `invoice-${invoiceId}.pdf`,
        ),
      }
    },

    async getBillingCompanies() {
      return unwrapArray(await request('GET', '/billing-companies'), RawBillingCompany)
    },

    async getBankAccounts() {
      return unwrapArray(await request('GET', '/bank-accounts'), RawBankAccount)
    },

    async getCompanySettings() {
      return unwrap<RawCompanySettings>(await request('GET', '/company-settings'))
    },

    async getEvents(since, opts2 = {}) {
      const qs = buildQuery({
        since,
        limit: opts2.limit,
        type: opts2.type,
      })
      const raw = await request('GET', `/events${qs}`)
      return EventsFeedResponse.parse(raw)
    },

    async *streamEvents(opts2 = {}) {
      const qs = buildQuery({ since: opts2.since })
      const res = await fetchImpl(`${apiBase}/stream${qs}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: 'text/event-stream' },
        ...(opts2.signal ? { signal: opts2.signal } : {}),
      })
      if (res.status === 401) throw new InvoicingUnauthorizedError(401, '/stream', null)
      if (!res.ok || !res.body) throw new InvoicingApiError(res.status, '/stream', null)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Frames are separated by a blank line.
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const event = parseSseEvent(block)
          if (event) yield event
        }
      }
    },

    async registerWebhook(payload) {
      return unwrap<RegisterWebhookResult>(await request('POST', '/webhooks', payload))
    },

    async listWebhooks() {
      const raw = await request('GET', '/webhooks')
      if (Array.isArray(raw)) return raw as RegisterWebhookResult[]
      if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
        return (raw as { data: RegisterWebhookResult[] }).data
      }
      return []
    },

    async deleteWebhook(id) {
      await request('DELETE', `/webhooks/${id}`)
    },
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Non-JSON body (e.g. an HTML error page). Return the raw text so the
    // error path can surface something useful without throwing here.
    return { raw: text }
  }
}

/**
 * Construct a client from stored config. Throws if not configured so callers
 * fail closed rather than hitting the API anonymously.
 */
export async function createClientFromConfig(): Promise<InvoicingClient> {
  // Lazy import to avoid a config <-> client cycle at module load.
  const { loadInvoicingConfig } = await import('./config')
  const cfg = await loadInvoicingConfig()
  if (!cfg.apiKey) {
    throw new InvoicingUnauthorizedError(401, '/', {
      message: 'Invoicing API key not configured',
    })
  }
  return createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })
}
