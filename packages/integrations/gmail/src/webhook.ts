// Gmail Pub/Sub push handler. CLAUDE.md §14.
//
// Cloud Pub/Sub authenticates pushes via a Bearer JWT in the Authorization
// header signed by Google. We verify it with `google-auth-library`'s
// OAuth2Client.verifyIdToken against the registered audience (the public URL
// of this endpoint). The push body itself is JSON; the inner `message.data`
// is base64-encoded JSON containing { emailAddress, historyId }.

import { OAuth2Client } from 'google-auth-library'

import type { GmailPushNotification, PubSubPushBody } from './types.js'

export const AUTH_HEADER = 'authorization' as const

export type VerifyResult =
  | { ok: true; notification: GmailPushNotification }
  | {
      ok: false
      reason:
        | 'missing_token'
        | 'invalid_token'
        | 'invalid_body'
        | 'invalid_payload'
        | 'wrong_audience'
    }

/**
 * Caller-supplied verifier seam. Production passes the OAuth2Client; tests
 * pass a stub that returns a fake payload or throws on invalid_token.
 */
export interface JwtVerifier {
  verify(idToken: string, audience: string): Promise<{ email?: string | null }>
}

export function makeGoogleVerifier(): JwtVerifier {
  const client = new OAuth2Client()
  return {
    async verify(idToken, audience) {
      const ticket = await client.verifyIdToken({ idToken, audience })
      const payload = ticket.getPayload()
      return { email: payload?.email ?? null }
    },
  }
}

// Test seam: a process-global verifier override. Tests set this so they do
// not have to mock the google-auth-library module surface; production code
// never sets it. Cleared at the end of each test.
let injectedVerifier: JwtVerifier | null = null

export function setVerifier(v: JwtVerifier | null): void {
  injectedVerifier = v
}

export function getInjectedVerifier(): JwtVerifier | null {
  return injectedVerifier
}

export interface VerifyOptions {
  audience: string
  /** Email address of the Pub/Sub service account, e.g.
   *  `gmail-watcher@my-proj.iam.gserviceaccount.com`. Optional — if set, we
   *  reject any token signed by a different identity. */
  expectedServiceAccountEmail?: string
  verifier?: JwtVerifier
}

export async function verifyAndParse(
  rawBody: string,
  authorizationHeader: string | null,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  if (!authorizationHeader || !authorizationHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, reason: 'missing_token' }
  }
  const idToken = authorizationHeader.slice('bearer '.length).trim()
  if (!idToken) return { ok: false, reason: 'missing_token' }

  const verifier = opts.verifier ?? injectedVerifier ?? makeGoogleVerifier()
  let payload: { email?: string | null }
  try {
    payload = await verifier.verify(idToken, opts.audience)
  } catch {
    return { ok: false, reason: 'invalid_token' }
  }

  if (
    opts.expectedServiceAccountEmail &&
    payload.email !== opts.expectedServiceAccountEmail
  ) {
    return { ok: false, reason: 'wrong_audience' }
  }

  let parsed: PubSubPushBody
  try {
    parsed = JSON.parse(rawBody) as PubSubPushBody
  } catch {
    return { ok: false, reason: 'invalid_body' }
  }
  if (!parsed.message || typeof parsed.message.data !== 'string') {
    return { ok: false, reason: 'invalid_body' }
  }

  let inner: GmailPushNotification
  try {
    const decoded = Buffer.from(parsed.message.data, 'base64').toString('utf8')
    inner = JSON.parse(decoded) as GmailPushNotification
  } catch {
    return { ok: false, reason: 'invalid_payload' }
  }
  if (typeof inner.emailAddress !== 'string' || typeof inner.historyId !== 'string') {
    return { ok: false, reason: 'invalid_payload' }
  }

  return { ok: true, notification: inner }
}
