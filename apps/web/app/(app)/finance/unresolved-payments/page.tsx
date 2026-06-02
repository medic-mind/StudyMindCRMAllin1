// Unresolved Stripe payments tray (ADR 0030). RSC. Lists successful Stripe
// charges that arrived for a customer with no StripeCustomer→Family mapping —
// a human links each to a Family or dismisses it. Nothing auto-creates a
// Family from a payment (CLAUDE.md §3). Finance roles only (§20).

import { TRPCError } from '@trpc/server'

import { UnresolvedPaymentRow } from '@/components/finance/UnresolvedPaymentRow'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Table, Tbody, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

interface Item {
  id: string
  stripeChargeId: string
  stripeCustomerId: string
  amountMinor: number
  currency: string
  receivedAt: Date
  customerEmail: string | null
  customerName: string | null
  description: string | null
  productHandles: string[]
}

export default async function UnresolvedPaymentsPage(): Promise<JSX.Element> {
  const caller = await createServerCaller()
  let items: Item[] = []
  let forbidden = false
  try {
    const res = await caller.finance.unresolvedPayments.list()
    items = res.items as Item[]
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <>
        <PageHeader title="Unresolved payments" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need the Manager, Senior Manager, or CEO role to view unresolved
            Stripe payments.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Unresolved payments"
        subtitle="Successful Stripe charges we could not match to a family. Link each to the right family (this records the payment and remembers the customer for next time) or dismiss it. Nothing is auto-assigned."
      />
      <PageBody>
        {items.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
            <p className="text-sm font-medium text-emerald-700">
              No unresolved payments — every Stripe charge is matched to a family.
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              Charges for an unknown Stripe customer will appear here for finance
              to link or dismiss.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
            <Table>
              <Thead>
                <Tr>
                  <Th>Received</Th>
                  <Th>Customer</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Product</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {items.map((p) => (
                  <UnresolvedPaymentRow key={p.id} payment={p} />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </PageBody>
    </>
  )
}
