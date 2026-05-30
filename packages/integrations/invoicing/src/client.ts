// Typed HTTP client for the B2B Invoices Platform REST API
// (b2b.studymind.co.uk/api/v1). One file, tsc-clean.
//
// Auth: `Authorization: Bearer sk_live_…`. 401 = bad/revoked key,
// 403 = read-only key. All outbound goes through safeFetch (SSRF allowlist,
// CLAUDE.md §44.2). Field names are VERBATIM from the API contract.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import { EventsFeedResponse, RawCustomer, RawInvoice, type ListResponse } from './types'

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
  client_type?: 'uk_b2b' | 'school' | 'summer_school' | 'international'
  prices_include_vat?: boolean
  bank_account_id?: string
  po_number?: string
  line_items?: LineItemWritePayload[]
}

export interface PaymentWritePayload {
  amount: number
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
  createCustomer(payload: CustomerWritePayload): Promise<RawCustomer>
  updateCustomer(id: string, payload: CustomerWritePayload): Promise<RawCustomer>
  archiveCustomer(id: string): Promise<void>
  listInvoices(query?: ListInvoicesQuery): Promise<ListResponse<RawInvoice>>
  getInvoice(id: string): Promise<RawInvoice>
  createInvoice(payload: InvoiceWritePayload): Promise<RawInvoice>
  updateInvoice(id: string, payload: Partial<InvoiceWritePayload>): Promise<RawInvoice>
  issueInvoice(id: string): Promise<RawInvoice>
  recordPayment(invoiceId: string, payload: PaymentWritePayload): Promise<unknown>
  markPaid(invoiceId: string): Promise<RawInvoice>
  sendInvoice(invoiceId: string, payload?: SendInvoicePayload): Promise<SendInvoiceResult>
  getEvents(since: string, opts?: { limit?: number; type?: string }): Promise<EventsFeedResponse>
  registerWebhook(payload: RegisterWebhookPayload): Promise<RegisterWebhookResult>
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

    async recordPayment(invoiceId, payload) {
      return request('POST', `/invoices/${invoiceId}/payments`, payload)
    },

    async markPaid(invoiceId) {
      return unwrap<RawInvoice>(await request('POST', `/invoices/${invoiceId}/mark-paid`))
    },

    async sendInvoice(invoiceId, payload = {}) {
      return unwrap<SendInvoiceResult>(
        await request('POST', `/invoices/${invoiceId}/send`, payload),
      )
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

    async registerWebhook(payload) {
      return unwrap<RegisterWebhookResult>(await request('POST', '/webhooks', payload))
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
