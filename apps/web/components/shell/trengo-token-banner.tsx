// Banner shown in the (app) shell when the signed-in agent's Trengo
// token is within 14 days of expiry, or already expired. CLAUDE.md §11:
// per-agent tokens rotate every 90 days; expired tokens fail closed.

import Link from 'next/link'

import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth/server'

const WARN_DAYS = 14
const MS_PER_DAY = 24 * 60 * 60 * 1000

export async function TrengoTokenBanner(): Promise<JSX.Element | null> {
  const me = await getCurrentUser()
  if (!me) return null

  const row = await db.trengoToken.findUnique({
    where: { agentId: me.id },
    select: { expiresAt: true },
  })
  if (!row) return null

  const now = Date.now()
  const expiresAt = row.expiresAt.getTime()
  const diffDays = Math.floor((expiresAt - now) / MS_PER_DAY)

  if (diffDays > WARN_DAYS) return null

  if (diffDays < 0) {
    return (
      <div
        role="alert"
        className="border-b border-red-300 bg-red-50 px-6 py-2 text-sm text-red-900"
      >
        Your Trengo token has expired. Outbound messages are blocked.{' '}
        <Link href="/account/trengo/connect" className="underline">
          Reconnect Trengo
        </Link>{' '}
        to resume.
      </div>
    )
  }

  return (
    <div className="border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      Your Trengo token expires in {diffDays} day{diffDays === 1 ? '' : 's'}.{' '}
      <Link href="/account/trengo/connect" className="underline">
        Rotate now
      </Link>{' '}
      to avoid an interruption.
    </div>
  )
}
