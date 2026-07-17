// /account/setup-2fa — TOTP enrolment.
// CLAUDE.md §20 (mandatory MFA for super_admin/admin/finance/dsl).
// The middleware redirects privileged-role users with no totpEnabledAt
// to this page; everyone else can reach it voluntarily.

import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'

import { Setup2faClient } from './Setup2faClient'

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
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-2">
        <span className="inline-flex items-center rounded-full bg-primary-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
          Required to continue
        </span>
        <h1 className="text-xl font-semibold text-neutral-900">
          Secure your account with two-factor
        </h1>
        <p className="text-sm text-neutral-600">
          To protect the family, finance and safeguarding data in the CRM, every
          account uses two-factor authentication. Alongside your password you
          enter a six-digit code from Google Authenticator each time you sign in.
          It takes about two minutes to set up — the steps below walk you through
          it, and you can&apos;t reach the CRM until it&apos;s done.
        </p>
        <p className="text-xs text-neutral-500">
          Not ready right now? You can{' '}
          <a href="/api/auth/signout" className="font-medium text-neutral-700 hover:underline">
            sign out
          </a>{' '}
          — nothing is locked, and you&apos;ll be brought back here next time you
          sign in.
        </p>
      </header>
      <Setup2faClient />
    </div>
  )
}
