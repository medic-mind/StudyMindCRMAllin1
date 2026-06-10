// Direct Debit workspace (ADR 0038). The complete GoCardless mirror — plans
// (every status, past included), payments, customers & mandates, plus the
// defaulter triage — with human-confirmed create / cancel / pause / resume
// actions. Nothing is auto-charged or auto-dunned (CLAUDE.md §3).
// Finance roles only (CLAUDE.md §20); the full-history import is CEO +
// Senior Manager.

import { Suspense } from 'react'

import { DirectDebitWorkspace } from '@/components/finance/gocardless/DirectDebitWorkspace'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'

export const dynamic = 'force-dynamic'

const FINANCE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])
const IMPORT_ROLES = new Set(['ceo', 'senior_manager'])

export default async function DirectDebitPage(): Promise<JSX.Element> {
  const me = await getCurrentUser()
  const role = me?.role ?? ''

  if (!FINANCE_ROLES.has(role)) {
    return (
      <>
        <PageHeader title="Direct Debits" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need the Manager, Senior Manager, or CEO role to view Direct Debits.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Direct Debits"
        subtitle="Every GoCardless plan, payment, customer and mandate — past and present — mirrored live. Create plans, collect one-off payments, pause, resume or cancel; every action is confirmed by a person and audited."
      />
      <PageBody>
        <Suspense>
          <DirectDebitWorkspace canImport={IMPORT_ROLES.has(role)} />
        </Suspense>
      </PageBody>
    </>
  )
}
