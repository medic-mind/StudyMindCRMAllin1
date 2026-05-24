// /account/setup-2fa — TOTP enrolment.
// CLAUDE.md §20 (mandatory MFA for super_admin/admin/finance/dsl).
// The middleware redirects privileged-role users with no totpEnabledAt
// to this page; everyone else can reach it voluntarily.

import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'

import { Setup2faFlow } from './flow'

export const dynamic = 'force-dynamic'

export default async function Setup2faPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')
  const user = await db.user.findUnique({
    where: { id: me.id },
    select: { totpEnabledAt: true },
  })
  if (user?.totpEnabledAt) {
    // Already enrolled — send the user to /account where they can disable.
    redirect('/account')
  }
  return (
    <div className="max-w-xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">
          Set up two-factor authentication
        </h1>
        <p className="text-sm text-neutral-600">
          Two-factor adds a six-digit code from your phone to every sign-in. It
          is required for admin and finance staff.
        </p>
      </header>
      <Setup2faFlow />
    </div>
  )
}
