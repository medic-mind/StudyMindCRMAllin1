// Shared RSC shell for every Direct Debits route (ADR 0038). One role gate +
// header; the client workspace handles the tab content. Not a route file —
// imported by page.tsx and [tab]/page.tsx.

import {
  DirectDebitWorkspace,
  type DdTab,
} from '@/components/finance/gocardless/DirectDebitWorkspace'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'

const FINANCE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])
const IMPORT_ROLES = new Set(['ceo', 'senior_manager'])

const SUBTITLES: Record<DdTab, string> = {
  overview:
    'The GoCardless master dashboard — recurring value on the book, what came in, what failed, and what needs a human. Every figure is mirrored live from GoCardless.',
  plans:
    'Every Direct Debit plan, past and present. Create, pause, resume or cancel — each action is confirmed by a person and audited.',
  payments:
    'Every GoCardless payment with its live status. Collect one-offs, retry failures, cancel pending collections.',
  customers:
    'Every GoCardless customer and mandate, plus Direct Debit sign-up links — emailed automatically with a 3-day reminder.',
  payouts:
    'Bank transfers of collected funds to StudyMind, with the customer payments inside each one.',
  activity:
    'Every GoCardless event the moment it happens — payments, mandates, plans and payouts, newest first.',
  issues:
    'Families that have defaulted on a Direct Debit, sorted by outstanding balance. Nothing here is auto-chased.',
}

export async function DirectDebitsPage({ tab }: { tab: DdTab }): Promise<JSX.Element> {
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
      <PageHeader title="Direct Debits" subtitle={SUBTITLES[tab]} />
      <PageBody>
        <DirectDebitWorkspace tab={tab} canImport={IMPORT_ROLES.has(role)} />
      </PageBody>
    </>
  )
}
