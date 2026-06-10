// GoCardless HTTP client.
//
// We deliberately use direct HTTP (fetch) rather than `gocardless-nodejs`:
// - The webhook signature is HMAC-SHA-256 of the raw body (CLAUDE.md §9), so
//   the SDK is not required for verification.
// - Our needs are narrow (refetch mandate, refetch payment, create redirect
//   flow); a thin wrapper keeps the surface area auditable.
//
// One factory per process is fine — `fetch` handles connection pooling.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import type {
  GcCustomerResource,
  GcListMeta,
  GcMandateResource,
  GcPaymentResource,
  GcRedirectFlowResource,
  GcSubscriptionResource,
} from './types'

// Pinned API version. Bumping this is a coordinated change.
export const GOCARDLESS_API_VERSION = '2015-07-06' as const

export type GocardlessEnvironment = 'live' | 'sandbox'

const BASE_URL_BY_ENV: Record<GocardlessEnvironment, string> = {
  live: 'https://api.gocardless.com',
  sandbox: 'https://api-sandbox.gocardless.com',
}

export interface GocardlessClientOptions {
  accessToken?: string
  environment?: GocardlessEnvironment
  apiVersion?: string
  /** Override for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export interface GocardlessClient {
  readonly baseUrl: string
  getMandate(mandateId: string): Promise<GcMandateResource>
  getPayment(paymentId: string): Promise<GcPaymentResource>
  getCustomer(customerId: string): Promise<GcCustomerResource>
  getSubscription(subscriptionId: string): Promise<GcSubscriptionResource>
  createRedirectFlow(input: CreateRedirectFlowInput): Promise<GcRedirectFlowResource>
  /**
   * Complete a redirect flow after the customer finishes the hosted page.
   * GoCardless creates the customer + mandate at this moment.
   */
  completeRedirectFlow(
    redirectFlowId: string,
    sessionToken: string,
  ): Promise<GcRedirectFlowResource>

  // Paginated lists (ADR 0038). GoCardless keyset cursors: pass `after` from
  // the previous page's meta until it comes back null.
  listCustomers(params?: GcListParams): Promise<GcList<GcCustomerResource>>
  listMandates(params?: GcListParams & { customer?: string }): Promise<GcList<GcMandateResource>>
  listSubscriptions(
    params?: GcListParams & { customer?: string; mandate?: string; status?: string },
  ): Promise<GcList<GcSubscriptionResource>>
  listPayments(
    params?: GcListParams & { customer?: string; mandate?: string; subscription?: string },
  ): Promise<GcList<GcPaymentResource>>

  // Mutations (ADR 0038). All carry an Idempotency-Key supplied by the caller
  // so Inngest/tRPC retries never double-act (CLAUDE.md §2, §17).
  createSubscription(
    input: CreateSubscriptionInput,
    idempotencyKey: string,
  ): Promise<GcSubscriptionResource>
  cancelSubscription(subscriptionId: string): Promise<GcSubscriptionResource>
  pauseSubscription(subscriptionId: string): Promise<GcSubscriptionResource>
  resumeSubscription(subscriptionId: string): Promise<GcSubscriptionResource>
  createPayment(input: CreatePaymentInput, idempotencyKey: string): Promise<GcPaymentResource>
  cancelPayment(paymentId: string): Promise<GcPaymentResource>
  retryPayment(paymentId: string): Promise<GcPaymentResource>
  cancelMandate(mandateId: string): Promise<GcMandateResource>

  /** Escape hatch for tests and rare endpoints. */
  request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T>
}

export interface GcListParams {
  after?: string
  limit?: number
}

export interface GcList<T> {
  items: T[]
  /** Cursor for the next page; null on the last page. */
  after: string | null
}

export interface CreateSubscriptionInput {
  amount: number
  currency: string
  interval_unit: 'weekly' | 'monthly' | 'yearly'
  interval?: number
  day_of_month?: number
  name?: string
  start_date?: string
  end_date?: string
  count?: number
  metadata?: Record<string, string>
  links: { mandate: string }
}

export interface CreatePaymentInput {
  amount: number
  currency: string
  charge_date?: string
  description?: string
  metadata?: Record<string, string>
  links: { mandate: string }
}

export interface CreateRedirectFlowInput {
  description: string
  session_token: string
  success_redirect_url: string
  prefilled_customer?: Record<string, unknown>
  metadata?: Record<string, string>
}

let cached: { client: GocardlessClient; key: string } | null = null

export class GocardlessApiError extends Error {
  override readonly name = 'GocardlessApiError'
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`GoCardless ${status} on ${path}`)
  }
}

/**
 * Create (or return the cached) GoCardless client.
 * Reads `GOCARDLESS_ACCESS_TOKEN` and `GOCARDLESS_ENVIRONMENT` from env.
 */
export function createClient(opts: GocardlessClientOptions = {}): GocardlessClient {
  const accessToken = opts.accessToken ?? process.env['GOCARDLESS_ACCESS_TOKEN']
  if (!accessToken) {
    throw new Error('GOCARDLESS_ACCESS_TOKEN is not set')
  }
  const envName: GocardlessEnvironment =
    opts.environment ??
    ((process.env['GOCARDLESS_ENVIRONMENT'] as GocardlessEnvironment | undefined) ?? 'sandbox')
  if (envName !== 'live' && envName !== 'sandbox') {
    throw new Error(`GOCARDLESS_ENVIRONMENT must be "live" or "sandbox", got ${String(envName)}`)
  }
  const baseUrl = BASE_URL_BY_ENV[envName]
  const apiVersion = opts.apiVersion ?? GOCARDLESS_API_VERSION
  const fetchImpl = opts.fetchImpl ?? safeFetch

  // Cache only the env-driven instance; explicit overrides skip the cache.
  const cacheKey = `${envName}:${apiVersion}`
  const isEnvDriven = !opts.accessToken && !opts.fetchImpl
  if (isEnvDriven && cached && cached.key === cacheKey) {
    return cached.client
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'GoCardless-Version': apiVersion,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
      throw new GocardlessApiError(res.status, path, parsed)
    }
    return parsed as T
  }

  function listPath(base: string, params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value))
    }
    const qs = search.toString()
    return qs ? `${base}?${qs}` : base
  }

  async function list<T>(
    base: string,
    key: string,
    params: Record<string, string | number | undefined>,
  ): Promise<GcList<T>> {
    const res = await request<Record<string, unknown> & { meta?: GcListMeta }>(
      'GET',
      listPath(base, params),
    )
    const items = (res[key] as T[] | undefined) ?? []
    return { items, after: res.meta?.cursors?.after ?? null }
  }

  const client: GocardlessClient = {
    baseUrl,
    request,
    async getMandate(mandateId) {
      const res = await request<{ mandates: GcMandateResource }>('GET', `/mandates/${mandateId}`)
      return res.mandates
    },
    async getPayment(paymentId) {
      const res = await request<{ payments: GcPaymentResource }>('GET', `/payments/${paymentId}`)
      return res.payments
    },
    async getCustomer(customerId) {
      const res = await request<{ customers: GcCustomerResource }>(
        'GET',
        `/customers/${customerId}`,
      )
      return res.customers
    },
    async getSubscription(subscriptionId) {
      const res = await request<{ subscriptions: GcSubscriptionResource }>(
        'GET',
        `/subscriptions/${subscriptionId}`,
      )
      return res.subscriptions
    },
    async createRedirectFlow(input) {
      const res = await request<{ redirect_flows: GcRedirectFlowResource }>(
        'POST',
        '/redirect_flows',
        { redirect_flows: input },
        input.session_token,
      )
      return res.redirect_flows
    },
    async completeRedirectFlow(redirectFlowId, sessionToken) {
      const res = await request<{ redirect_flows: GcRedirectFlowResource }>(
        'POST',
        `/redirect_flows/${redirectFlowId}/actions/complete`,
        { data: { session_token: sessionToken } },
      )
      return res.redirect_flows
    },

    listCustomers(params = {}) {
      return list<GcCustomerResource>('/customers', 'customers', {
        after: params.after,
        limit: params.limit ?? 200,
      })
    },
    listMandates(params = {}) {
      return list<GcMandateResource>('/mandates', 'mandates', {
        after: params.after,
        limit: params.limit ?? 200,
        customer: params.customer,
      })
    },
    listSubscriptions(params = {}) {
      return list<GcSubscriptionResource>('/subscriptions', 'subscriptions', {
        after: params.after,
        limit: params.limit ?? 200,
        customer: params.customer,
        mandate: params.mandate,
        status: params.status,
      })
    },
    listPayments(params = {}) {
      return list<GcPaymentResource>('/payments', 'payments', {
        after: params.after,
        limit: params.limit ?? 200,
        customer: params.customer,
        mandate: params.mandate,
        subscription: params.subscription,
      })
    },

    async createSubscription(input, idempotencyKey) {
      const res = await request<{ subscriptions: GcSubscriptionResource }>(
        'POST',
        '/subscriptions',
        { subscriptions: input },
        idempotencyKey,
      )
      return res.subscriptions
    },
    async cancelSubscription(subscriptionId) {
      const res = await request<{ subscriptions: GcSubscriptionResource }>(
        'POST',
        `/subscriptions/${subscriptionId}/actions/cancel`,
        { data: {} },
      )
      return res.subscriptions
    },
    async pauseSubscription(subscriptionId) {
      const res = await request<{ subscriptions: GcSubscriptionResource }>(
        'POST',
        `/subscriptions/${subscriptionId}/actions/pause`,
        { data: {} },
      )
      return res.subscriptions
    },
    async resumeSubscription(subscriptionId) {
      const res = await request<{ subscriptions: GcSubscriptionResource }>(
        'POST',
        `/subscriptions/${subscriptionId}/actions/resume`,
        { data: {} },
      )
      return res.subscriptions
    },
    async createPayment(input, idempotencyKey) {
      const res = await request<{ payments: GcPaymentResource }>(
        'POST',
        '/payments',
        { payments: input },
        idempotencyKey,
      )
      return res.payments
    },
    async cancelPayment(paymentId) {
      const res = await request<{ payments: GcPaymentResource }>(
        'POST',
        `/payments/${paymentId}/actions/cancel`,
        { data: {} },
      )
      return res.payments
    },
    async retryPayment(paymentId) {
      const res = await request<{ payments: GcPaymentResource }>(
        'POST',
        `/payments/${paymentId}/actions/retry`,
        { data: {} },
      )
      return res.payments
    },
    async cancelMandate(mandateId) {
      const res = await request<{ mandates: GcMandateResource }>(
        'POST',
        `/mandates/${mandateId}/actions/cancel`,
        { data: {} },
      )
      return res.mandates
    },
  }

  if (isEnvDriven) cached = { client, key: cacheKey }
  return client
}

/**
 * Reset the cached client. Tests only.
 */
export function __resetClientForTests(): void {
  cached = null
}
