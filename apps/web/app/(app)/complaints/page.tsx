// Active complaints queue — every open complaint across all customers, worked
// to zero. Filter tabs (active / mine / resolved / all) are URL-driven. Each
// row links to the customer's Complaints section. RSC (CLAUDE.md §26).

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

type Filter = 'active' | 'mine' | 'resolved' | 'all'

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
]

const STATUS_TONE: Record<string, BadgeTone> = {
  open: 'danger',
  in_progress: 'info',
  resolved: 'success',
  dismissed: 'neutral',
}
const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}
const SEVERITY_CLS: Record<string, string> = {
  high: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200',
}

export default async function ComplaintsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const sp = await searchParams
  const filter: Filter =
    sp.filter === 'mine' || sp.filter === 'resolved' || sp.filter === 'all' ? sp.filter : 'active'
  const caller = await createServerCaller()
  const complaints = await caller.complaint.list({ filter, limit: 200 })
  const now = new Date()

  return (
    <>
      <PageHeader
        title="Complaints"
        subtitle={`${complaints.length} ${filter === 'active' ? 'active' : ''} complaint${
          complaints.length === 1 ? '' : 's'
        }`}
      />
      <PageBody>
        <div
          role="tablist"
          aria-label="Complaint filter"
          className="mb-4 inline-flex rounded-md border border-neutral-200 bg-white p-0.5 shadow-card"
        >
          {FILTERS.map((f) => {
            const active = f.value === filter
            return (
              <Link
                key={f.value}
                role="tab"
                aria-selected={active}
                href={`/complaints?filter=${f.value}`}
                className={
                  active
                    ? 'rounded px-3 py-1.5 text-sm font-medium text-primary-800 bg-primary-50'
                    : 'rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50'
                }
              >
                {f.label}
              </Link>
            )
          })}
        </div>

        {complaints.length === 0 ? (
          <Card className="px-10 py-14 text-center">
            <p className="text-sm font-medium text-neutral-800">No complaints here.</p>
            <p className="mt-1 text-xs text-neutral-500">
              Log a complaint from any customer&apos;s page — it appears here while it&apos;s active.
            </p>
          </Card>
        ) : (
          <Card className="divide-y divide-neutral-100">
            {complaints.map((c) => (
              <Link
                key={c.id}
                href={`/contacts/${c.contactId}#section-complaints`}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50/80"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {c.title}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {c.contactName}
                    {' · '}
                    {formatRelativeTime(new Date(c.createdAt), now)}
                    {c.category ? ` · ${c.category}` : ''}
                    {c.updateCount > 0
                      ? ` · ${c.updateCount} update${c.updateCount === 1 ? '' : 's'}`
                      : ''}
                    {c.taskId ? ' · task' : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      SEVERITY_CLS[c.severity] ?? SEVERITY_CLS.low
                    }`}
                  >
                    {c.severity}
                  </span>
                  <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                    {STATUS_LABEL[c.status] ?? c.status}
                  </Badge>
                </span>
              </Link>
            ))}
          </Card>
        )}
      </PageBody>
    </>
  )
}
