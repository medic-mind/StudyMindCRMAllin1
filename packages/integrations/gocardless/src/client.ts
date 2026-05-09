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
  GcMandateResource,
  GcPaymentResource,
  GcRedirectFlowResource,
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
  createRedirectFlow(input: CreateRedirectFlowInput): Promise<GcRedirectFlowResource>
  /** Escape hatch for tests and rare endpoints. */
  request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T>
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
    async createRedirectFlow(input) {
      const res = await request<{ redirect_flows: GcRedirectFlowResource }>(
        'POST',
        '/redirect_flows',
        { redirect_flows: input },
        input.session_token,
      )
      return res.redirect_flows
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
