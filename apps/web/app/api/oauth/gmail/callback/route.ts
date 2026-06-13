// Gmail OAuth callback. ADR 0012, CLAUDE.md §14, §44.2.
//
// Verifies the single-use state, exchanges the code for tokens, encrypts the
// refresh token via KMS envelope encryption, persists the cipher pointer on
// User, and starts the Pub/Sub watch. All meaningful outcomes are audited.

import { NextResponse } from 'next/server'

import { writeAuditLogEntry } from '@studymind/audit'
import { startBackfill, BackfillAlreadyRunningError } from '@studymind/core/backfill'
import { encryptField } from '@studymind/core/safeguarding'
import { setupWatchForUser } from '@studymind/integration-gmail/client'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { inngest } from '@studymind/jobs'
import { db } from '@/lib/db'

import { getCurrentUser } from '@/lib/auth/server'

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
] as const

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  id_token?: string
}

// Build user-facing redirects against the PUBLIC app URL, not `req.url`. Behind
// a proxy (Railway) `req.url` is the internal bind (e.g. http://0.0.0.0:8080),
// which is unreachable from the browser — so a successful connect would land on
// a broken URL. Fall back to the request origin only when the env is unset.
function appBaseUrl(req: Request): string {
  const fromEnv = process.env['NEXT_PUBLIC_APP_URL']?.trim()
  if (fromEnv) {
    try {
      // Must be an absolute http(s) URL — a bare host like "crm.studymind.co.uk"
      // makes `new URL(path, base)` throw, which would 500 the callback.
      const u = new URL(fromEnv)
      if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.protocol}//${u.host}`
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(req.url).origin
}

function redirectWithError(req: Request, error: string): Response {
  const url = new URL('/settings/mailbox', appBaseUrl(req))
  url.searchParams.set('error', error)
  return NextResponse.redirect(url, 302)
}

export async function GET(req: Request): Promise<Response> {
  let me: Awaited<ReturnType<typeof getCurrentUser>> = null
  try {
    me = await getCurrentUser()
    if (!me) {
      return NextResponse.redirect(new URL('/sign-in', appBaseUrl(req)), 302)
    }
    return await runCallback(req, me)
  } catch (err) {
    // The connect flow must never return a raw 500 (golden rule: no silent
    // failure, but also no scary dead-end). Capture the real cause in the audit
    // log and bounce back to Settings → Mailbox with a friendly message.
    await writeAuditLogEntry(db, {
      actorId: me?.id ?? null,
      action: 'gmail.oauth_error',
      target: { type: 'User', id: me?.id ?? 'unknown' },
      after: { message: err instanceof Error ? err.message : String(err) },
    }).catch(() => undefined)
    return redirectWithError(req, 'connect_failed')
  }
}

async function runCallback(
  req: Request,
  me: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
): Promise<Response> {
  const inUrl = new URL(req.url)
  const code = inUrl.searchParams.get('code')
  const state = inUrl.searchParams.get('state')
  const oauthError = inUrl.searchParams.get('error')

  if (oauthError) {
    await writeAuditLogEntry(db, {
      actorId: me.id,
      action: 'gmail.oauth_denied',
      target: { type: 'User', id: me.id },
      after: { reason: oauthError },
    })
    return redirectWithError(req, oauthError)
  }

  if (!code || !state) {
    return redirectWithError(req, 'invalid_request')
  }

  // Single-use state. Delete in the same transaction that reads it so a
  // racing replay loses. The `findUnique` + `delete` pattern is safe because
  // `state` is unique; only one delete will succeed.
  const stateRow = await db.oAuthState.findUnique({ where: { state } })
  if (
    !stateRow ||
    stateRow.userId !== me.id ||
    stateRow.provider !== 'gmail' ||
    stateRow.expiresAt < new Date()
  ) {
    if (stateRow) {
      await db.oAuthState.delete({ where: { state } }).catch(() => null)
    }
    await writeAuditLogEntry(db, {
      actorId: me.id,
      action: 'gmail.oauth_invalid_state',
      target: { type: 'User', id: me.id },
    })
    return redirectWithError(req, 'invalid_state')
  }
  await db.oAuthState.delete({ where: { state } })

  const clientId = process.env['GOOGLE_OAUTH_CLIENT_ID']
  const clientSecret = process.env['GOOGLE_OAUTH_CLIENT_SECRET']
  const appUrl = process.env['NEXT_PUBLIC_APP_URL']
  if (!clientId || !clientSecret || !appUrl) {
    return redirectWithError(req, 'oauth_not_configured')
  }
  const redirectUri = `${appUrl.replace(/\/$/, '')}/api/oauth/gmail/callback`

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })

  const tokenRes = await safeFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!tokenRes.ok) {
    return redirectWithError(req, 'token_exchange_failed')
  }
  const tokens = (await tokenRes.json()) as TokenResponse
  if (!tokens.refresh_token || !tokens.access_token) {
    // Without a refresh token we cannot do background sync. This happens if
    // the user previously consented and `prompt=consent` was missing — but
    // we always send it, so this is a misconfiguration.
    return redirectWithError(req, 'no_refresh_token')
  }

  const grantedScopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean)
  const missing = REQUIRED_SCOPES.filter((s) => !grantedScopes.includes(s))
  if (missing.length > 0) {
    await writeAuditLogEntry(db, {
      actorId: me.id,
      action: 'gmail.oauth_scope_mismatch',
      target: { type: 'User', id: me.id },
      after: { granted: grantedScopes, missing },
    })
    return redirectWithError(req, 'scope_mismatch')
  }

  // Look up the address using the access token. This avoids a second OAuth
  // round trip and gives us the canonical mailbox identity to persist.
  const profileRes = await safeFetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { headers: { authorization: `Bearer ${tokens.access_token}` } },
  )
  if (!profileRes.ok) {
    // Surface the most common, actionable cause distinctly: the Gmail API not
    // being enabled in the OAuth client's Google Cloud project (403
    // SERVICE_DISABLED / accessNotConfigured). Everything else stays a generic
    // profile failure with the status appended so support can diagnose.
    const detail = await profileRes.text().catch(() => '')
    const apiDisabled =
      profileRes.status === 403 &&
      /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(detail)
    await writeAuditLogEntry(db, {
      actorId: me.id,
      action: 'gmail.oauth_profile_failed',
      target: { type: 'User', id: me.id },
      after: { status: profileRes.status, apiDisabled },
    })
    return redirectWithError(
      req,
      apiDisabled ? 'gmail_api_disabled' : `profile_lookup_failed_${profileRes.status}`,
    )
  }
  const profile = (await profileRes.json()) as { emailAddress?: string }
  const address = profile.emailAddress
  if (!address) {
    return redirectWithError(req, 'profile_lookup_failed')
  }

  // Encrypt + persist the refresh token.
  const cipher = await encryptField(db, {
    ownerType: 'User',
    ownerId: me.id,
    fieldName: 'gmail.refresh_token',
    plaintext: tokens.refresh_token,
    ctx: { actorId: me.id, purpose: 'gmail.oauth_connect' },
  })

  await db.user.update({
    where: { id: me.id },
    data: {
      gmailRefreshTokenCipherId: cipher.id,
      gmailConnectionStatus: 'connected',
    },
  })

  // Best-effort watch setup. If it fails, mark needs_reconnect so the UI
  // can prompt; the user keeps the encrypted token so retry is cheap.
  let watchOk = true
  try {
    await setupWatchForUser(me.id, { address })
  } catch {
    watchOk = false
    await db.user.update({
      where: { id: me.id },
      data: { gmailConnectionStatus: 'needs_reconnect' },
    })
  }

  await writeAuditLogEntry(db, {
    actorId: me.id,
    action: 'gmail.oauth_connected',
    target: { type: 'User', id: me.id },
    after: { address, watchOk, encryptedFieldId: cipher.id },
  })

  // ADR 0017: kick off a one-shot 90-day historic backfill on first connect.
  // Best-effort — a failure here must not break the OAuth redirect, and a
  // second connect attempt is idempotent (BackfillAlreadyRunningError).
  try {
    await startBackfill(db, inngest, {
      provider: 'gmail',
      agentId: me.id,
      windowDays: 90,
      ctx: { actorId: me.id, requestId: `gmail-oauth:${me.id}` },
    })
  } catch (err) {
    if (!(err instanceof BackfillAlreadyRunningError)) {
      // Swallow — surfaced via the absence of a BackfillJob; the admin can
      // re-trigger from the integrations page.
    }
  }

  const redir = new URL('/settings/mailbox', appBaseUrl(req))
  redir.searchParams.set('connected', '1')
  if (!watchOk) redir.searchParams.set('warning', 'watch_setup_failed')
  return NextResponse.redirect(redir, 302)
}
