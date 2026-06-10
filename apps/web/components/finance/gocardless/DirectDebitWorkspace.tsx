'use client'

// Direct Debits workspace (ADR 0038): the single pane for everything
// GoCardless. Promoted to its own top-level nav section with a master
// dashboard (Overview) plus Plans · Payments · Customers & mandates ·
// Issues. Tabs are real routes (/direct-debits/<tab>) so the sidebar
// children, deep links, and back button all behave (CLAUDE.md §26).

import Link from 'next/link'
import { toast } from 'sonner'

import { DefaulterRow } from '@/components/finance/DefaulterRow'
import { Button } from '@/components/ui/button'
import { Table, Tbody, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'

import { CustomersTab } from './CustomersTab'
import { OverviewTab } from './OverviewTab'
import { PaymentsTab } from './PaymentsTab'
import { PlansTab } from './PlansTab'

export const DD_TABS = [
  { value: 'overview', label: 'Overview', href: '/direct-debits' },
  { value: 'plans', label: 'Plans', href: '/direct-debits/plans' },
  { value: 'payments', label: 'Payments', href: '/direct-debits/payments' },
  { value: 'customers', label: 'Customers & mandates', href: '/direct-debits/customers' },
  { value: 'issues', label: 'Issues', href: '/direct-debits/issues' },
] as const

export type DdTab = (typeof DD_TABS)[number]['value']

export function DirectDebitWorkspace({ tab, canImport }: { tab: DdTab; canImport: boolean }) {
  const importStatus = trpc.gocardless.import.status.useQuery(undefined, {
    refetchInterval: (query) => {
      const status = query.state.data?.job?.status
      return status === 'pending' || status === 'running' ? 4000 : false
    },
  })

  const utils = trpc.useUtils()
  const startImport = trpc.gocardless.import.start.useMutation({
    onSuccess: () => {
      toast.success('Import started — every customer, mandate, plan and payment will appear here.')
      void utils.gocardless.import.status.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const job = importStatus.data?.job
  const importing = job?.status === 'running' || job?.status === 'pending'

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 border-b border-neutral-200">
        <nav className="-mb-px flex gap-4 overflow-x-auto" aria-label="Direct Debit tabs">
          {DD_TABS.map((t) => (
            <Link
              key={t.value}
              href={t.href}
              aria-current={tab === t.value ? 'page' : undefined}
              className={
                tab === t.value
                  ? 'whitespace-nowrap border-b-2 border-primary-600 px-1 pb-2 text-sm font-semibold text-primary-700'
                  : 'whitespace-nowrap border-b-2 border-transparent px-1 pb-2 text-sm font-medium text-neutral-500 hover:border-neutral-300 hover:text-neutral-700'
              }
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {canImport ? (
          <Button
            size="sm"
            variant="secondary"
            className="mb-2 shrink-0"
            disabled={startImport.isPending || importing}
            onClick={() => startImport.mutate()}
          >
            {importing ? 'Importing…' : 'Import full history'}
          </Button>
        ) : null}
      </div>

      {job && importing ? (
        <div className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">
          Importing from GoCardless… {job.processedCount} records so far ({job.matchedCount}{' '}
          linked to the CRM). This keeps running in the background — you can leave the page.
        </div>
      ) : null}
      {job?.status === 'failed' && job.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          Last import failed: {job.error}
        </div>
      ) : null}

      {tab === 'overview' ? <OverviewTab /> : null}
      {tab === 'plans' ? <PlansTab /> : null}
      {tab === 'payments' ? <PaymentsTab /> : null}
      {tab === 'customers' ? <CustomersTab /> : null}
      {tab === 'issues' ? <IssuesTab /> : null}
    </div>
  )
}

function IssuesTab() {
  const defaulters = trpc.finance.directDebit.listDefaulters.useQuery({})
  const items = defaulters.data?.items ?? []

  if (defaulters.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading defaulters…</p>
  }
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
        <p className="text-sm font-medium text-emerald-700">
          No Direct Debit defaulters — every mandate is healthy.
        </p>
        <p className="mt-1 text-sm text-neutral-500">
          The nightly defaulter scan runs after reconciliation; any family that defaults will
          appear here for finance to chase.
        </p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
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
  )
}
