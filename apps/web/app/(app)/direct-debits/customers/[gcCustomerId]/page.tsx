// GoCardless customer record (ADR 0038) — /direct-debits/customers/<CU id>.
// The drill-down behind every customer row: identity, mandates, plans,
// payments, sign-up links. Same finance role gate as the workspace.

import { CustomerDetail } from '@/components/finance/gocardless/CustomerDetail'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'

export const dynamic = 'force-dynamic'

const FINANCE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

export default async function Page({
  params,
}: {
  params: Promise<{ gcCustomerId: string }>
}): Promise<JSX.Element> {
  const { gcCustomerId } = await params
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
        subtitle="Customer record — every mandate, plan, payment and sign-up link, mirrored live from GoCardless."
      />
      <PageBody>
        <CustomerDetail gcCustomerId={gcCustomerId} />
      </PageBody>
    </>
  )
}
