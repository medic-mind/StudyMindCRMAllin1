// Summer Camp bookings — the CRM's on-record booking list (CampBookingRecord
// mirror, so it works even when the camp app is down). URL-driven filters,
// camp-app-style stat strip, tonal pills, and a slide-over detail editor.
// CLAUDE.md §26: RSC by default; client islands only for the editor + sync.

import Link from 'next/link'

import { getCurrentUser } from '@/lib/auth/server'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  ClearFiltersButton,
  FilterBar,
  ToggleFilter,
} from '@/components/ui/filter-bar'
import { FacetedFilter } from '@/components/ui/faceted-filter'
import {
  AlertTriangleIcon,
  CalendarIcon,
  CheckCircleIcon,
  CoinsIcon,
  UsersIcon,
} from '@/components/ui/icon'
import { SearchField } from '@/components/ui/search-field'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'
import { cn } from '@/lib/cn'

import { CampsNav } from '../CampsNav'
import { BookingStatusBadge } from '../camp-status'
import { StatTile } from '../StatTile'
import { BookingSlideOver, type BookingItem } from './BookingSlideOver'
import { SyncNowButton } from './SyncNowButton'

export const dynamic = 'force-dynamic'

const WRITE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'])
const CANCEL_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })
function money(minor: number | null): string {
  return minor === null ? '—' : gbp.format(minor / 100)
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d)
}

interface Params {
  q?: string
  status?: string
  camp?: string
  year?: string
  unassigned?: string
  open?: string
}

function buildQuery(params: Params, overrides: Record<string, string | null>): string {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) if (v) merged[k] = v
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete merged[k]
    else merged[k] = v
  }
  const qs = new URLSearchParams(merged).toString()
  return qs ? `?${qs}` : ''
}

export default async function CampBookingsPage({ searchParams }: { searchParams?: Params }) {
  const params = searchParams ?? {}
  const [me, caller] = await Promise.all([getCurrentUser(), createServerCaller()])
  const canEdit = Boolean(me && WRITE_ROLES.has(me.role))
  const canCancel = Boolean(me && CANCEL_ROLES.has(me.role))

  const year = params.year && /^\d{4}$/.test(params.year) ? parseInt(params.year, 10) : undefined
  const statuses = new Set(['pending', 'confirmed', 'cancelled', 'waitlist'])
  const status = statuses.has(params.status ?? '') ? (params.status as 'pending') : undefined

  const list = await caller.summerCamp.bookings.list({
    ...(params.q ? { search: params.q } : {}),
    ...(status ? { status } : {}),
    ...(params.camp ? { campId: params.camp } : {}),
    ...(year ? { year } : {}),
    ...(params.unassigned === '1' ? { unassigned: true } : {}),
  })

  // Camp names for the filter dropdown — best-effort (from the live feed for
  // the selected year); the list itself never depends on the camp app.
  let campOptions: { value: string; label: string }[] = []
  try {
    const feed = await caller.summerCamp.camps({ year: year ?? new Date().getFullYear() })
    campOptions = (feed.feed?.camps ?? []).map((c) => ({ value: c.id, label: c.name }))
  } catch {
    campOptions = []
  }
  if (params.camp && !campOptions.some((o) => o.value === params.camp)) {
    const fromRow = list.items.find((i) => i.campId === params.camp)
    campOptions = [...campOptions, { value: params.camp, label: fromRow?.campName ?? 'Selected camp' }]
  }

  const openItem = params.open ? (list.items.find((i) => i.id === params.open) ?? null) : null
  const stats = list.stats

  return (
    <>
      <PageHeader
        title="Camp bookings"
        subtitle="Every Summer Camp booking, on record in the CRM. Edit details, assign camps, add notes — changes sync back to the camp app instantly."
        actions={<SyncNowButton connected={list.connected} canSync={canEdit} />}
      />
      <PageBody>
        <CampsNav />

        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile icon={<UsersIcon size={18} />} tone="primary" label="Bookings" value={list.total} />
          <StatTile
            icon={<CheckCircleIcon size={18} />}
            tone="success"
            label="Confirmed"
            value={stats.byStatus['confirmed'] ?? 0}
          />
          <StatTile
            icon={<CalendarIcon size={18} />}
            tone="warn"
            label="Pending"
            value={stats.byStatus['pending'] ?? 0}
          />
          <StatTile
            icon={<AlertTriangleIcon size={18} />}
            tone="danger"
            label="Needs camp"
            value={stats.unassigned}
          />
          <StatTile
            icon={<CoinsIcon size={18} />}
            tone="info"
            label="Collected"
            value={money(stats.paidMinor)}
            hint={`of ${money(stats.totalMinor)} booked`}
          />
        </div>
        <p className="mb-4 text-[11px] text-neutral-400">Totals reflect your current filters.</p>

        <FilterBar className="mb-4">
          <SearchField placeholder="Search student, guardian, camp, subject…" resetKeys={['open']} />
          <FacetedFilter
            paramKey="status"
            label="Status"
            options={[
              { value: 'confirmed', label: 'Confirmed' },
              { value: 'pending', label: 'Pending' },
              { value: 'waitlist', label: 'Waitlist' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
            resetKeys={['open']}
          />
          {campOptions.length > 0 ? (
            <FacetedFilter paramKey="camp" label="Camp" options={campOptions} resetKeys={['open']} />
          ) : null}
          <ToggleFilter paramKey="unassigned" label="Needs camp assignment" tone="danger" />
          <ClearFiltersButton paramKeys={['q', 'status', 'camp', 'unassigned', 'open']} />
          {list.years.length > 0 ? (
            <span className="ml-auto flex items-center gap-1.5">
              {list.years.map((y) => (
                <Link
                  key={y}
                  href={`/camps/bookings${buildQuery(params, { year: y === year ? null : String(y), open: null })}`}
                  aria-current={y === year ? 'page' : undefined}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-xs font-medium',
                    y === year
                      ? 'border-primary-200 bg-primary-50 text-primary-700'
                      : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300',
                  )}
                >
                  {y}
                </Link>
              ))}
            </span>
          ) : null}
        </FilterBar>

        {list.mirrorCount === 0 ? (
          <Card variant="dashed" className="p-10 text-center">
            <UsersIcon size={40} className="mx-auto text-neutral-200" />
            <p className="mt-3 text-sm font-medium text-neutral-800">No bookings on record yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              {list.connected
                ? 'Import the camp app’s bookings with “Sync from camp” above (or the full Import on the Overview page) — new bookings then arrive automatically.'
                : 'Connect the Summer Camp app (Overview page explains how) — bookings then sync in automatically and stay on record here.'}
            </p>
          </Card>
        ) : list.items.length === 0 ? (
          <Card variant="dashed" className="p-8 text-center text-sm text-neutral-500">
            No bookings match this view — clear a filter to widen it.
          </Card>
        ) : (
          <Card className="p-0">
            <Table>
              <Thead>
                <Tr>
                  <Th>Student</Th>
                  <Th>Guardian</Th>
                  <Th>Camp</Th>
                  <Th>Subject</Th>
                  <Th>Week</Th>
                  <Th>Dates</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Paid / total</Th>
                </Tr>
              </Thead>
              <Tbody>
                {list.items.map((b) => (
                  <Tr key={b.id}>
                    <Td className="py-2.5">
                      <Link
                        href={`/camps/bookings${buildQuery(params, { open: b.id })}`}
                        className="flex items-center gap-2.5 font-medium text-neutral-900 hover:text-primary-700"
                      >
                        <Avatar name={b.studentName ?? 'Unnamed'} size={26} />
                        {b.studentName ?? 'Unnamed'}
                      </Link>
                    </Td>
                    <Td className="py-2.5">
                      <span className="block">{b.guardianName ?? '—'}</span>
                      <span className="block text-xs text-neutral-400">{b.guardianEmail ?? ''}</span>
                    </Td>
                    <Td className="py-2.5">
                      {b.campName ?? <Badge tone="warn">Unassigned</Badge>}
                    </Td>
                    <Td className="py-2.5">{b.subject ?? '—'}</Td>
                    <Td className="py-2.5">
                      {b.weekLabel ?? (b.weekNumber ? `Week ${b.weekNumber}` : '—')}
                    </Td>
                    <Td className="whitespace-nowrap py-2.5">
                      {fmtDate(b.startDate)} – {fmtDate(b.endDate)}
                    </Td>
                    <Td className="py-2.5">
                      <BookingStatusBadge status={b.status} />
                    </Td>
                    <Td className="whitespace-nowrap py-2.5 text-right tabular-nums">
                      {money(b.paidMinor)} / {money(b.totalMinor)}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <p className="border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500">
              Showing {list.items.length} of {list.total} booking{list.total === 1 ? '' : 's'}
              {list.total > list.items.length ? ' — narrow the filters to see the rest' : ''}.
            </p>
          </Card>
        )}

        <BookingSlideOver
          key={openItem?.id ?? 'closed'}
          item={openItem as BookingItem | null}
          closeHref={`/camps/bookings${buildQuery(params, { open: null })}`}
          listYear={year ?? new Date().getFullYear()}
          canEdit={canEdit}
          canCancel={canCancel}
        />
      </PageBody>
    </>
  )
}
