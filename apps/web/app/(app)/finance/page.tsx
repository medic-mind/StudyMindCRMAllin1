// Finance dashboard. CLAUDE.md §6.3 (reconciliation triangle), §20 (only
// admin / finance see this), §26 (RSC by default, dense lists, plain
// English empty states).

import Link from 'next/link'
import { TRPCError } from '@trpc/server'

import { DiscrepancyActions } from '@/components/finance/DiscrepancyActions'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

const CATEGORY_LABEL: Record<string, string> = {
  hours_mismatch: 'Hours mismatch',
  payment_unallocated: 'Payment unallocated',
  late_failure: 'Late failure',
  late_failure_pending_action: 'Late failure — pending action',
  churned_with_active_subscription: 'Churned with active subscription',
  la_family_with_card_subscription: 'LA-billed family has card subscription',
  direct_debit_default: 'Direct Debit default',
  other: 'Other',
}

interface DiscrepancyItem {
  id: string
  familyId: string
  familyName: string | null
  familyState: string
  category: string
  summary: string
  payload?: unknown
  createdAt: Date
  resolvedAt: Date | null
}

function readPaymentIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>
  const candidate = p['paymentId'] ?? p['payment_id']
  return typeof candidate === 'string' ? candidate : undefined
}

function readBookingIdsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as Record<string, unknown>
  const candidate = p['candidateBookingIds'] ?? p['bookingIds']
  return Array.isArray(candidate) ? candidate.filter((x): x is string => typeof x === 'string') : []
}

function groupByCategory(items: DiscrepancyItem[]): Map<string, DiscrepancyItem[]> {
  const groups = new Map<string, DiscrepancyItem[]>()
  for (const item of items) {
    const list = groups.get(item.category) ?? []
    list.push(item)
    groups.set(item.category, list)
  }
  return groups
}

const CATEGORY_TONE: Record<string, BadgeTone> = {
  hours_mismatch: 'warn',
  payment_unallocated: 'info',
  late_failure: 'danger',
  late_failure_pending_action: 'danger',
  churned_with_active_subscription: 'danger',
  la_family_with_card_subscription: 'warn',
  direct_debit_default: 'danger',
  other: 'neutral',
}

const FAMILY_STATE_TONE: Record<string, BadgeTone> = {
  lead: 'neutral',
  trial: 'info',
  active: 'success',
  at_risk: 'warn',
  churned: 'danger',
}

export default async function FinancePage() {
  const caller = await createServerCaller()
  let items: DiscrepancyItem[] = []
  let forbidden = false
  try {
    const res = await caller.finance.discrepancy.list({ limit: 100, includeResolved: false })
    items = res.items as DiscrepancyItem[]
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
        <PageHeader title="Finance" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need the Manager, Senior Manager, or CEO role to view
            reconciliation discrepancies.
          </p>
        </PageBody>
      </>
    )
  }

  const groups = groupByCategory(items)

  return (
    <>
      <PageHeader
        title="Finance"
        subtitle="Open reconciliation discrepancies across active families. Nothing is ever auto-resolved — every item below needs a human decision."
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link
              href="/direct-debits"
              className="text-neutral-700 hover:text-neutral-900 hover:underline"
            >
              Direct Debits →
            </Link>
            <Link
              href="/finance/payment-links"
              className="text-neutral-700 hover:text-neutral-900 hover:underline"
            >
              Payment links →
            </Link>
            <Link
              href="/finance/refunds"
              className="text-neutral-700 hover:text-neutral-900 hover:underline"
            >
              Refunds →
            </Link>
          </div>
        }
      />
      <PageBody>
        {items.length === 0 ? (
          <Card className="p-10 text-center">
            <p className="text-sm font-medium text-emerald-700">
              No open discrepancies — reconciliation is clean.
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              The nightly reconcile runs at 02:00 UTC; anything that needs a
              human decision will appear here.
            </p>
          </Card>
        ) : (
          <div className="space-y-8">
            {Array.from(groups.entries()).map(([category, group]) => (
              <section key={category}>
                <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-neutral-700">
                  {CATEGORY_LABEL[category] ?? category}
                  <Badge tone={CATEGORY_TONE[category] ?? 'neutral'}>
                    {group.length}
                  </Badge>
                </h2>
                <Card className="mt-3 overflow-hidden">
                  <ul className="divide-y divide-neutral-100">
                  {group.map((d) => (
                    <li key={d.id} className="flex flex-col gap-2 p-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                            <span className="truncate">
                              {d.familyName ?? d.familyId}
                            </span>
                            <Badge tone={FAMILY_STATE_TONE[d.familyState] ?? 'neutral'}>
                              {d.familyState}
                            </Badge>
                          </div>
                          <div className="mt-1 text-sm text-neutral-700">
                            {d.summary}
                          </div>
                        </div>
                        <time
                          className="shrink-0 font-mono text-xs tabular-nums text-neutral-500"
                          dateTime={d.createdAt.toISOString()}
                        >
                          {formatRelativeTime(d.createdAt)}
                        </time>
                      </div>
                      <DiscrepancyActions
                        discrepancyId={d.id}
                        category={d.category}
                        paymentId={readPaymentIdFromPayload(d.payload)}
                        candidateBookingIds={readBookingIdsFromPayload(d.payload)}
                      />
                    </li>
                  ))}
                  </ul>
                </Card>
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </>
  )
}
