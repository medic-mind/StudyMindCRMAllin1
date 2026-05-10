// Banner surfaced in the (app) shell when the signed-in user's Gmail
// connection has flipped to `needs_reconnect` (background refresh got
// `invalid_grant` from Google). ADR 0012, CLAUDE.md §14.

import Link from 'next/link'

import { db } from '@/lib/db'

import { getCurrentUser } from '@/lib/auth/server'

export async function GmailReconnectBanner(): Promise<JSX.Element | null> {
  const me = await getCurrentUser()
  if (!me) return null
  const row = await db.user.findUnique({
    where: { id: me.id },
    select: { gmailConnectionStatus: true },
  })
  if (row?.gmailConnectionStatus !== 'needs_reconnect') return null
  return (
    <div className="border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      Your Gmail connection needs attention.{' '}
      <Link href="/settings/mailbox" className="underline">
        Reconnect mailbox
      </Link>{' '}
      to resume background sync.
    </div>
  )
}
