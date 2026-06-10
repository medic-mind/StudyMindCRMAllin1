'use client'

// Direct Debit workspace (ADR 0038): the single pane for everything
// GoCardless — plans (all statuses, past included), payments, customers &
// mandates, and the existing defaulter triage. Tab state lives in the URL
// (CLAUDE.md §26).

import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

import { DefaulterRow } from '@/components/finance/DefaulterRow'
import { Button } from '@/components/ui/button'
import { Table, Tbody, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { CustomersTab } from './CustomersTab'
import { PaymentsTab } from './PaymentsTab'
import { PlansTab } from './PlansTab'

const TABS = [
  { value: 'plans', label: 'Plans' },
  { value: 'payments', label: 'Payments' },
  { value: 'customers', label: 'Customers & mandates' },
  { value: 'issues', label: 'Issues' },
] as const

type Tab = (typeof TABS)[number]['value']

export function DirectDebitWorkspace({ canImport }: { canImport: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const raw = searchParams.get('tab')
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : 'plans'

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', next)
    router.replace(`/finance/direct-debit?${params.toString()}`, { scroll: false })
  }

  const overview = trpc.gocardless.overview.useQuery()
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

  const o = overview.data
  const job = importStatus.data?.job

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat
            label="Active plans"
            value={o ? String(o.subscriptions['active'] ?? 0) : '…'}
          />
          <Stat label="Paused" value={o ? String(o.subscriptions['paused'] ?? 0) : '…'} />
          <Stat label="Active mandates" value={o ? String(o.activeMandates) : '…'} />
          <Stat
            label="Customers to link"
            value={o ? String(o.customers.unlinked) : '…'}
            warn={Boolean(o && o.customers.unlinked > 0)}
          />
          <Stat
            label="Collected (all time)"
            value={o ? formatMoneyMinor(o.collected.totalMinor) : '…'}
          />
        </div>
        {canImport ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={startImport.isPending || job?.status === 'running' || job?.status === 'pending'}
            onClick={() => startImport.mutate()}
          >
            {job?.status === 'running' || job?.status === 'pending'
              ? 'Importing…'
              : 'Import full history'}
          </Button>
        ) : null}
      </div>

      {job && (job.status === 'running' || job.status === 'pending') ? (
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

      <div className="border-b border-neutral-200">
        <nav className="-mb-px flex gap-4" aria-label="Direct Debit tabs">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={
                tab === t.value
                  ? 'border-b-2 border-primary-600 px-1 pb-2 text-sm font-semibold text-primary-700'
                  : 'border-b-2 border-transparent px-1 pb-2 text-sm font-medium text-neutral-500 hover:border-neutral-300 hover:text-neutral-700'
              }
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'plans' ? <PlansTab /> : null}
      {tab === 'payments' ? <PaymentsTab /> : null}
      {tab === 'customers' ? <CustomersTab /> : null}
      {tab === 'issues' ? <IssuesTab /> : null}
    </div>
  )
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-card">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono text-lg tabular-nums ${
          warn ? 'text-amber-700' : 'text-neutral-900'
        }`}
      >
        {value}
      </div>
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
