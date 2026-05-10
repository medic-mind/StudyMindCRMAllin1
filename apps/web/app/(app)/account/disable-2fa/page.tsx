// /account/disable-2fa — Disable TOTP MFA. Requires the current password +
// a current TOTP code. CLAUDE.md §20.

import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'

import { Disable2faForm } from './form'

export const dynamic = 'force-dynamic'

export default async function Disable2faPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')
  const user = await db.user.findUnique({
    where: { id: me.id },
    select: { totpEnabledAt: true },
  })
  if (!user?.totpEnabledAt) {
    redirect('/account/setup-2fa')
  }
  return (
    <div className="max-w-md space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">
          Disable two-factor authentication
        </h1>
        <p className="text-sm text-neutral-600">
          Confirm with your current password and a fresh code from your
          Authenticator app. Privileged accounts are required to keep
          two-factor enabled — disabling it will redirect you back to setup
          on your next request.
        </p>
      </header>
      <Disable2faForm />
    </div>
  )
}
