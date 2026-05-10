// Gmail OAuth consent kick-off. ADR 0012, CLAUDE.md §14.
//
// Per-agent flow: each signed-in user initiates their own consent. We mint a
// single-use `state` token, persist it to OAuthState (5-minute window), and
// 302 to Google's consent screen. The callback verifies state and exchanges
// the code.

import { NextResponse } from 'next/server'

import { createId } from '@paralleldrive/cuid2'

import { generateToken } from '@studymind/core/auth/passwords'
import { db } from '@/lib/db'

import { getCurrentUser } from '@/lib/auth/server'

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
] as const

export async function GET(req: Request): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) {
    const url = new URL('/sign-in', req.url)
    return NextResponse.redirect(url, 302)
  }

  const clientId = process.env['GOOGLE_OAUTH_CLIENT_ID']
  const appUrl = process.env['NEXT_PUBLIC_APP_URL']
  if (!clientId || !appUrl) {
    return NextResponse.json({ error: 'oauth_not_configured' }, { status: 500 })
  }

  const state = generateToken()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

  await db.oAuthState.create({
    data: {
      id: createId(),
      userId: me.id,
      provider: 'gmail',
      state,
      expiresAt,
    },
  })

  const redirectUri = `${appUrl.replace(/\/$/, '')}/api/oauth/gmail/callback`
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })

  return NextResponse.redirect(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`, 302)
}
