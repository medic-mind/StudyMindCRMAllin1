import { describe, expect, it } from 'vitest'

import { trpcResponseError } from './response-error'

describe('trpcResponseError', () => {
  it('turns a 401 into a clean session message — even with a non-tRPC JSON body', () => {
    // The auth middleware returns `{ error: 'unauthorized' }` (application/json)
    // on an expired session; that isn't a tRPC envelope, so without this the
    // client throws the opaque "Unable to transform response from server".
    expect(trpcResponseError(401, 'application/json')).toMatch(/session/i)
    expect(trpcResponseError(401, 'application/json; charset=utf-8')).toMatch(/session/i)
    expect(trpcResponseError(401, 'text/html')).toMatch(/session/i)
  })

  it('passes real tRPC responses through untouched (success + error envelopes)', () => {
    expect(trpcResponseError(200, 'application/json; charset=utf-8')).toBeNull()
    // tRPC's own error envelopes are JSON and must reach the client so it can
    // show the server's message (validation, permission, conflict, bug).
    expect(trpcResponseError(400, 'application/json')).toBeNull()
    expect(trpcResponseError(403, 'application/json')).toBeNull()
    expect(trpcResponseError(409, 'application/json')).toBeNull()
    expect(trpcResponseError(500, 'application/json')).toBeNull()
  })

  it('maps non-JSON bodies (HTML gateway/error pages) to a friendly message by status', () => {
    expect(trpcResponseError(502, 'text/html')).toMatch(/server had a problem/i)
    expect(trpcResponseError(503, '')).toMatch(/server had a problem/i)
    expect(trpcResponseError(403, 'text/html')).toMatch(/session/i)
    expect(trpcResponseError(400, 'text/html')).toMatch(/something went wrong/i)
    expect(trpcResponseError(0, '')).toMatch(/something went wrong/i)
  })
})
