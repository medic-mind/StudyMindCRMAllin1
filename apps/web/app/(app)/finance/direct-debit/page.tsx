// Direct Debit defaulters (Slice B). RSC. Lists families that have defaulted
// on a Direct Debit / instalment scheme, sorted by outstanding balance.
// Read-only analysis — nothing is auto-charged or auto-dunned (CLAUDE.md §3).
// Finance roles only (CLAUDE.md §20). Money formatted at render (§19/§29).

import { TRPCError } from '@trpc/server'

import { DefaulterRow } from '@/components/finance/DefaulterRow'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Table, Tbody, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

interface DefaulterItem {
  familyId: string
  billingContactName: string | null
  mandateStatus: string | null
  failedCount: number
  lastFailureAt: Date | null
  totalPaidMinor: number
  totalOwedMinor: number
  outstandingMinor: number
  reasons: string[]
}

export default async function DirectDebitDefaultersPage(): Promise<JSX.Element> {
  const caller = await createServerCaller()
  let items: DefaulterItem[] = []
  let forbidden = false
  try {
    const res = await caller.finance.directDebit.listDefaulters({})
    items = res.items as DefaulterItem[]
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
        <PageHeader title="Direct Debit issues" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need the Manager, Senior Manager, or CEO role to view Direct
            Debit defaulters.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Direct Debit issues"
        subtitle="Families that have defaulted on a Direct Debit or instalment scheme, sorted by outstanding balance. Nothing here is auto-chased — open a row to raise a dunning task or send a reminder."
      />
      <PageBody>
        {items.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-medium text-emerald-700">
              No Direct Debit defaulters — every mandate is healthy.
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              The nightly defaulter scan runs after reconciliation; any family
              that defaults will appear here for finance to chase.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-neutral-200 bg-white shadow-sm">
            <Table>
              <Thead>
                <Tr>
                  <Th>Billing contact</Th>
                  <Th>Mandate</Th>
                  <Th>Failures</Th>
                  <Th>Last failure</Th>
                  <Th className="text-right">Paid</Th>
                  <Th className="text-right">Owed</Th>
                  <Th className="text-right">Outstanding</Th>
                  <Th>Reasons</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {items.map((d) => (
                  <DefaulterRow key={d.familyId} defaulter={d} />
                ))}
              </Tbody>
            </Table>
          </div>
        )}
      </PageBody>
    </>
  )
}
