'use client'

// Direct Debits workspace (ADR 0038): the single pane for everything
// GoCardless. Promoted to its own top-level nav section with a master
// dashboard (Overview) plus Plans · Payments · Customers & mandates ·
// Issues. Tabs are real routes (/direct-debits/<tab>) so the sidebar
// children, deep links, and back button all behave (CLAUDE.md §26).

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { DefaulterRow } from '@/components/finance/DefaulterRow'
import { Button } from '@/components/ui/button'
import { Table, Tbody, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'

import { ActivityTab } from './ActivityTab'
import { RecoveryCasesSection } from './ChasingTab'
import { CustomersTab } from './CustomersTab'
import { OverviewTab } from './OverviewTab'
import { PaymentsTab } from './PaymentsTab'
import { PayoutsTab } from './PayoutsTab'
import { PlansTab } from './PlansTab'
import { ActivePlanArrearsSection, PlanShortfallsSection } from './PlanShortfallsSection'

export const DD_TABS = [
  { value: 'overview', label: 'Overview', href: '/direct-debits' },
  { value: 'plans', label: 'Plans', href: '/direct-debits/plans' },
  { value: 'payments', label: 'Payments', href: '/direct-debits/payments' },
  { value: 'customers', label: 'Customers & mandates', href: '/direct-debits/customers' },
  { value: 'payouts', label: 'Payouts', href: '/direct-debits/payouts' },
  { value: 'activity', label: 'Activity', href: '/direct-debits/activity' },
  { value: 'issues', label: 'Issues', href: '/direct-debits/issues' },
] as const

export type DdTab = (typeof DD_TABS)[number]['value']

export function DirectDebitWorkspace({
  tab,
  canImport,
  canChase = false,
}: {
  tab: DdTab
  canImport: boolean
  /** Manager+ — may add/edit/resolve chase cases (ADR 0045). */
  canChase?: boolean
}) {
  const importStatus = trpc.gocardless.import.status.useQuery(undefined, {
    refetchInterval: (query) => {
      const status = query.state.data?.job?.status
      return status === 'pending' || status === 'running' ? 8000 : false
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
      {tab === 'payouts' ? <PayoutsTab /> : null}
      {tab === 'activity' ? <ActivityTab /> : null}
      {tab === 'issues' ? <IssuesTab canWrite={canChase} /> : null}
    </div>
  )
}

// The single Issues tab (ADR 0045 amendment): the recovery-cases worklist (the
// CRM of people who owe money — chase, message, recover) at the top, and the
// auto-detected sources below (defaulters + cancelled-early / underpaid plans).
// Historic pre-go-live issues are hidden by default with a reveal toggle.
function IssuesTab({ canWrite }: { canWrite: boolean }) {
  const [includeHistoric, setIncludeHistoric] = useState(false)
  return (
    <div className="space-y-8">
      <RecoveryCasesSection canWrite={canWrite} />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Detected issues</h2>
            <p className="text-xs text-neutral-500">
              Underpayments and Direct Debits cancelled before every payment was collected. Open a
              recovery case from any row to see the message history, turn the automated reminders
              on/off, and send an email or text.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {canWrite ? (
              <Link
                href="/settings/dd-recovery-templates"
                className="text-xs font-medium text-primary-700 hover:underline"
              >
                Recovery templates &amp; settings →
              </Link>
            ) : null}
            <label className="flex items-center gap-1.5 text-xs text-neutral-600">
              <input
                type="checkbox"
                checked={includeHistoric}
                onChange={(e) => setIncludeHistoric(e.target.checked)}
              />
              Show issues before July 2026
            </label>
          </div>
        </div>
        <DefaultersSection includeHistoric={includeHistoric} canWrite={canWrite} />
        <PlanShortfallsSection includeHistoric={includeHistoric} canWrite={canWrite} />
        <ActivePlanArrearsSection includeHistoric={includeHistoric} canWrite={canWrite} />
      </div>
    </div>
  )
}

function DefaultersSection({
  includeHistoric,
  canWrite,
}: {
  includeHistoric: boolean
  canWrite: boolean
}) {
  const defaulters = trpc.finance.directDebit.listDefaulters.useQuery({ includeHistoric })
  const items = defaulters.data?.items ?? []

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-neutral-900">
          Defaulters — failed or inactive Direct Debits
        </h2>
        {items.length > 0 ? (
          <p className="text-xs text-neutral-500">
            {items.length} family{items.length === 1 ? '' : 'ies'} need chasing
          </p>
        ) : null}
      </div>

      {defaulters.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading defaulters…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center shadow-card">
          <p className="text-sm font-medium text-emerald-700">
            No Direct Debit defaulters — every mandate is healthy.
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            The nightly defaulter scan runs after reconciliation; any family that defaults will
            appear here for finance to chase.
          </p>
        </div>
      ) : (
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
                <DefaulterRow key={d.familyId} defaulter={d} canWrite={canWrite} />
              ))}
            </Tbody>
          </Table>
        </div>
      )}
    </section>
  )
}
