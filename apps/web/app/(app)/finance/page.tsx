// Finance dashboard. CLAUDE.md §6.3 (reconciliation triangle), §20 (only
// admin / finance see this), §26 (RSC by default, dense lists, plain
// English empty states).

import { TRPCError } from '@trpc/server'

import { DiscrepancyActions } from '@/components/finance/DiscrepancyActions'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

const CATEGORY_LABEL: Record<string, string> = {
  hours_mismatch: 'Hours mismatch',
  payment_unallocated: 'Payment unallocated',
  late_failure: 'Late failure',
  late_failure_pending_action: 'Late failure — pending action',
  churned_with_active_subscription: 'Churned with active subscription',
  ap_review_overdue: 'AP review overdue',
  la_family_with_card_subscription: 'LA-billed family has card subscription',
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
            You need the finance or admin role to view reconciliation
            discrepancies.
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
            <a
              href="/finance/payment-links"
              className="text-neutral-700 hover:text-neutral-900 hover:underline"
            >
              Payment links →
            </a>
            <a
              href="/finance/refunds"
              className="text-neutral-700 hover:text-neutral-900 hover:underline"
            >
              Refunds →
            </a>
          </div>
        }
      />
      <PageBody>
      {items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700">
          No open discrepancies. The nightly reconcile runs at 02:00 UTC and
          will surface anything that needs attention here.
        </div>
      ) : (
        <div className="space-y-8">
          {Array.from(groups.entries()).map(([category, group]) => (
            <section key={category}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
                {CATEGORY_LABEL[category] ?? category}{' '}
                <span className="ml-2 text-xs font-normal text-neutral-500">
                  {group.length}
                </span>
              </h2>
              <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
                {group.map((d) => (
                  <li key={d.id} className="flex flex-col gap-2 p-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-neutral-900">
                          {d.familyName ?? d.familyId}
                          <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                            {d.familyState}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-neutral-700">{d.summary}</div>
                      </div>
                      <div className="shrink-0 font-mono text-xs text-neutral-500 tabular-nums">
                        {d.createdAt.toISOString().slice(0, 10)}
                      </div>
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
            </section>
          ))}
        </div>
      )}
      </PageBody>
    </>
  )
}
