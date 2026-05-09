// Finance dashboard. CLAUDE.md §6.3 (reconciliation triangle), §20 (only
// admin / finance see this), §26 (RSC by default, dense lists, plain
// English empty states).

import { TRPCError } from '@trpc/server'

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
  createdAt: Date
  resolvedAt: Date | null
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Finance</h1>
        <p className="mt-2 text-sm text-neutral-600">
          You need the finance or admin role to view reconciliation discrepancies.
        </p>
      </div>
    )
  }

  const groups = groupByCategory(items)

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Finance</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Open reconciliation discrepancies across active families. Nothing is
        ever auto-resolved — every item below needs a human decision.
      </p>

      {items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700">
          No open discrepancies. The nightly reconcile runs at 02:00 UTC and
          will surface anything that needs attention here.
        </div>
      ) : (
        <div className="mt-8 space-y-8">
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
                  <li key={d.id} className="flex items-start justify-between gap-4 p-3">
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
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
