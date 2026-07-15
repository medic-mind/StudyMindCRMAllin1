// Crib gateway (2026-07). The in-app knowledge base was retired at the
// operator's request — the live Crib site is the single source of truth.
// This page gives staff the link plus the shared site password.
//
// SECURITY: the password comes from the CRIB_SITE_PASSWORD env var and is
// rendered server-side to AUTHENTICATED STAFF ONLY. It must never be
// hardcoded here — this repository is public.

import { redirect } from 'next/navigation'

import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'

export const dynamic = 'force-dynamic'

const CRIB_URL = 'https://crib.studymind.co.uk'

export default async function ProtocolsPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')

  const password = process.env['CRIB_SITE_PASSWORD']?.trim() || null

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Protocols & Policies"
        subtitle="The company knowledge base lives on the Crib site — protocols, pricing, playbooks and policies, always current."
      />
      <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-card">
        <a
          href={CRIB_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
        >
          Open the Crib site
        </a>
        <div className="mt-5 border-t border-neutral-100 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Team password
          </p>
          {password ? (
            <p className="mt-1 select-all font-mono text-base tabular-nums text-neutral-900">
              {password}
            </p>
          ) : (
            <p className="mt-1 text-sm text-neutral-500">
              Not configured yet — an admin needs to set the{' '}
              <code className="font-mono text-xs">CRIB_SITE_PASSWORD</code> environment
              variable in Railway, then this page shows it to signed-in staff.
            </p>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            Staff only — please don&apos;t share the password outside the team.
          </p>
        </div>
      </div>
    </div>
  )
}
