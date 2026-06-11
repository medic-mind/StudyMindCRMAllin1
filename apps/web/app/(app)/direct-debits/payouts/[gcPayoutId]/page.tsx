// Payout drill-down (ADR 0038 parity pass 2) — /direct-debits/payouts/<PO id>.
// Same finance role gate as the workspace.

import { PayoutDetail } from '@/components/finance/gocardless/PayoutDetail'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'

export const dynamic = 'force-dynamic'

const FINANCE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

export default async function Page({
  params,
}: {
  params: Promise<{ gcPayoutId: string }>
}): Promise<JSX.Element> {
  const { gcPayoutId } = await params
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
        subtitle="Payout record — the bank transfer and every customer payment settled inside it."
      />
      <PageBody>
        <PayoutDetail gcPayoutId={gcPayoutId} />
      </PageBody>
    </>
  )
}
