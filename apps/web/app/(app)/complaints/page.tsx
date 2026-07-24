// Complaints management hub — the master dashboard for complaints handling.
// Headline KPIs (live backlog, high-severity, unassigned, 30-day opened /
// resolved, avg resolution) sit above the worklist queue of every open
// complaint across all customers, worked to zero. Each row links to that
// customer's Complaints section in their CRM record (complaints are stored
// per-customer). Deep period analytics (charts, theme over time) live on the
// Manager+ /reports/complaints page, linked from here. RSC (CLAUDE.md §26).

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { getCurrentUser } from '@/lib/auth/server'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'
import { complaintStatusTone } from '@/lib/ui/status-tone'

import { NewComplaintDialog } from './NewComplaintDialog'

type Filter = 'active' | 'mine' | 'resolved' | 'all' | 'archived'

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'mine', label: 'Assigned to me' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
]

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

// Mirrors REPORT_ROLES in the reports router — the deep analytics page is
// Manager+, so only show its link to roles who can actually open it.
const REPORT_ROLES = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function fmtHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${Math.round(h * 10) / 10}h`
  return `${Math.round((h / 24) * 10) / 10}d`
}

export default async function ComplaintsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const sp = await searchParams
  const filter: Filter =
    sp.filter === 'mine' ||
    sp.filter === 'resolved' ||
    sp.filter === 'all' ||
    sp.filter === 'archived'
      ? sp.filter
      : 'active'
  const caller = await createServerCaller()
  const me = await getCurrentUser()
  const canSeeReport = me ? REPORT_ROLES.has(me.role) : false
  const [complaints, stats] = await Promise.all([
    caller.complaint.list({ filter, limit: 200 }),
    caller.complaint.dashboardStats(),
  ])
  const now = new Date()

  return (
    <>
      <PageHeader
        title="Complaints"
        subtitle="The hub for complaints handling — live backlog, then every open complaint to work to zero."
        actions={
          <div className="flex items-center gap-2">
            {canSeeReport ? (
              <Link
                href="/complaints/reports"
                className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-card transition-colors hover:bg-neutral-50"
              >
                Full analytics report →
              </Link>
            ) : null}
            <NewComplaintDialog />
          </div>
        }
      />
      <PageBody>
        {/* Headline KPIs — the "master dashboard" strip. */}
        <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Stat
            label="Active backlog"
            value={stats.activeBacklog}
            hint="Open + in progress now"
            tone={stats.activeBacklog > 0 ? 'danger' : 'success'}
          />
          <Stat
            label="High severity"
            value={stats.highSeverityActive}
            hint="Active, needs attention"
            tone={stats.highSeverityActive > 0 ? 'danger' : 'neutral'}
          />
          <Stat
            label="Unassigned"
            value={stats.unassignedActive}
            hint="Active, nobody owns"
            tone={stats.unassignedActive > 0 ? 'warn' : 'neutral'}
          />
          <Stat label="Opened" value={stats.openedLast30} hint="Last 30 days" tone="info" />
          <Stat label="Resolved" value={stats.resolvedLast30} hint="Last 30 days" tone="success" />
          <Stat
            label="Avg resolution"
            value={fmtHours(stats.avgResolutionHours)}
            hint="Open → resolved, 90d"
          />
        </section>

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
              Use the Log complaint button above (or any customer&apos;s page) — it appears here
              while it&apos;s active and is stored on the customer&apos;s record.
            </p>
          </Card>
        ) : (
          <Card className="divide-y divide-neutral-100">
            {complaints.map((c) => (
              <Link
                key={c.id}
                href={`/complaints/${c.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50/80"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {c.title}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {c.customerName}
                    {c.isManual ? ' (manual)' : ''}
                    {' · '}
                    {formatRelativeTime(new Date(c.createdAt), now)}
                    {c.category ? ` · ${c.category}` : ''}
                    {c.assigneeName ? ` · ${c.assigneeName}` : ''}
                    {c.updateCount > 0
                      ? ` · ${c.updateCount} update${c.updateCount === 1 ? '' : 's'}`
                      : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {c.archived ? (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
                      Archived
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      SEVERITY_CLS[c.severity] ?? SEVERITY_CLS.low
                    }`}
                  >
                    {c.severity}
                  </span>
                  <Badge tone={complaintStatusTone(c.status)}>
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

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: number | string
  hint?: string
  tone?: 'info' | 'success' | 'warn' | 'danger' | 'neutral'
}) {
  const accent: Record<typeof tone, string> = {
    info: 'text-primary-700',
    success: 'text-emerald-700',
    warn: 'text-amber-700',
    danger: 'text-rose-700',
    neutral: 'text-neutral-900',
  }
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${accent[tone]}`}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-neutral-500">{hint}</div> : null}
    </Card>
  )
}
