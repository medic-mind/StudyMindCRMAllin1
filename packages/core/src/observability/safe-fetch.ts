// Outbound HTTP wrapper that enforces the SSRF allowlist. CLAUDE.md §44.2.
//
// Every fetch in packages/integrations/** and elsewhere on the server side
// must call safeFetch instead of the global fetch. Hosts not listed in
// safe-fetch-allowlist.ts throw a BusinessError('OUTBOUND_HOST_BLOCKED'),
// which we surface as a 4xx upstream rather than a 5xx so tests are clear.
//
// Test bypass: when NODE_ENV === 'test' the host check is skipped so unit
// tests can stub `fetch` against any URL. Integration tests that want to
// exercise the allowlist call `safeFetch` directly with NODE_ENV !== 'test'.

import { BusinessError } from '../errors'

import { isAllowedHost } from './safe-fetch-allowlist'

export type SafeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export const safeFetch: SafeFetch = async (input, init) => {
  const url = typeof input === 'string' ? new URL(input) : input
  if (process.env.NODE_ENV !== 'test') {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BusinessError('OUTBOUND_HOST_BLOCKED', `Disallowed scheme ${url.protocol}`, {
        host: url.host,
      })
    }
    if (!isAllowedHost(url.host)) {
      throw new BusinessError('OUTBOUND_HOST_BLOCKED', `Host not allowlisted: ${url.host}`, {
        host: url.host,
      })
    }
  }
  return fetch(url, init)
}
