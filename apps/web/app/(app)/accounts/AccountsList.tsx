// Client island for the B2B accounts list. Dense table (CLAUDE.md §4) with
// inline status filter + live search + create button. Each row surfaces the
// org, clickable email + phone, student count + contracted hours, the
// call/text/email counts across the account's linked contacts, amount paid
// (paid uploaded invoices), and when we last contacted them.

'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/confirm'
import { FacetedFilter } from '@/components/ui/faceted-filter'
import { PageSizeSelect, PaginationBar, SortMenu, type SortOption } from '@/components/ui/list-controls'
import { Popover } from '@/components/ui/popover'
import { SearchField } from '@/components/ui/search-field'
import { Toolbar } from '@/components/ui/toolbar'
import {
  BuildingIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
} from '@/components/ui/icon'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { cn } from '@/lib/cn'
import { formatMoneyMinor } from '@/lib/format/money'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

import { AccountCreateForm } from './AccountCreateForm'

type Kind = 'school' | 'partnership'
type Status = 'prospect' | 'active' | 'paused' | 'churned'

interface AccountLabelChip {
  id: string
  name: string
  color: string | null
}

interface AccountRow {
  id: string
  kind: 'school' | 'partnership'
  name: string
  slug: string
  color: string | null
  description: string | null
  status: 'prospect' | 'active' | 'paused' | 'churned'
  contactEmail: string | null
  contactPhone: string | null
  website: string | null
  city: string | null
  country: string | null
  contactCount: number
  companies: ReadonlyArray<{
    id: string
    name: string
    slug: string
    color: string | null
  }>
  labels: ReadonlyArray<AccountLabelChip>
  studentCount: number
  hoursContracted: number
  hoursDelivered: number
  amountPaidMinor: number
  callCount: number
  textCount: number
  emailCount: number
  lastContactedAt: Date | string | null
  archived: boolean
  createdAt: Date | string
}

const STATUS_OPTIONS: ReadonlyArray<{ value: Status; label: string }> = [
  { value: 'prospect', label: 'Prospect' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'churned', label: 'Churned' },
]

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const STATUS_TONE: Record<Status, string> = {
  prospect: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  active: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  paused: 'bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200',
  churned: 'bg-red-50 text-red-700 ring-1 ring-red-200',
}

type SortKey =
  | 'name'
  | 'studentCount'
  | 'hoursContracted'
  | 'activity'
  | 'amountPaidMinor'
  | 'lastContactedAt'

const VALID_SORT_KEYS: ReadonlyArray<SortKey> = [
  'name',
  'studentCount',
  'hoursContracted',
  'activity',
  'amountPaidMinor',
  'lastContactedAt',
]
const ACCOUNT_SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { value: 'name', label: 'Name', defaultDir: 'asc' },
  { value: 'studentCount', label: 'Students', defaultDir: 'desc' },
  { value: 'hoursContracted', label: 'Hours', defaultDir: 'desc' },
  { value: 'activity', label: 'Activity', defaultDir: 'desc' },
  { value: 'amountPaidMinor', label: 'Amount paid', defaultDir: 'desc' },
  { value: 'lastContactedAt', label: 'Last contact', defaultDir: 'desc' },
]
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 20

function sortValue(a: AccountRow, key: SortKey): number | string {
  switch (key) {
    case 'name':
      return a.name.toLowerCase()
    case 'studentCount':
      return a.studentCount
    case 'hoursContracted':
      return a.hoursContracted
    case 'activity':
      return a.callCount + a.textCount + a.emailCount
    case 'amountPaidMinor':
      return a.amountPaidMinor
    case 'lastContactedAt':
      return a.lastContactedAt ? new Date(a.lastContactedAt).getTime() : 0
  }
}

export function AccountsList({
  kind,
  accounts,
  role,
}: {
  kind: Kind
  accounts: AccountRow[]
  /** Drives which bulk actions render; the server re-checks (CLAUDE.md §20). */
  role: string
}) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const confirm = useConfirm()
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const now = new Date()

  const canManage = MANAGE_ROLES.has(role)

  // Active label catalogue for the "Label" bulk action + the management link.
  // Manager+ can mutate; everyone reads, so it's safe to always fetch.
  const labelsQuery = trpc.accountLabel.pickList.useQuery(undefined, {
    enabled: canManage,
  })
  const labels = labelsQuery.data ?? []

  const bulkArchive = trpc.businessAccount.bulkArchive.useMutation()
  const bulkDelete = trpc.businessAccount.bulkDelete.useMutation()
  const bulkSetStatus = trpc.businessAccount.bulkSetStatus.useMutation()
  const bulkSetLabel = trpc.businessAccount.bulkSetLabel.useMutation()

  // Sort + pagination are URL-driven (shareable + consistent with the
  // Contacts list). The page already holds every filtered row in memory, so
  // both are instant client-side slices — no round-trip. Name defaults
  // ascending; numeric/recency columns default to "most first" (descending).
  const searchParams = useSearchParams()
  const pathname = usePathname()

  const rawSort = searchParams.get('sortBy')
  const sortKey: SortKey = (VALID_SORT_KEYS as ReadonlyArray<string>).includes(rawSort ?? '')
    ? (rawSort as SortKey)
    : 'name'
  const sortDir: 'asc' | 'desc' =
    searchParams.get('sortDir') === 'desc'
      ? 'desc'
      : searchParams.get('sortDir') === 'asc'
        ? 'asc'
        : sortKey === 'name'
          ? 'asc'
          : 'desc'

  function toggleSort(key: SortKey) {
    const params = new URLSearchParams(searchParams.toString())
    const dir =
      key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc'
    params.set('sortBy', key)
    params.set('sortDir', dir)
    params.delete('page')
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  const sortedAccounts = useMemo(
    () =>
      [...accounts].sort((a, b) => {
        const av = sortValue(a, sortKey)
        const bv = sortValue(b, sortKey)
        let cmp: number
        if (typeof av === 'string' && typeof bv === 'string') {
          cmp = av.localeCompare(bv)
        } else {
          cmp = (av as number) - (bv as number)
        }
        return sortDir === 'asc' ? cmp : -cmp
      }),
    [accounts, sortKey, sortDir],
  )

  const pageSizeRaw = Number(searchParams.get('pageSize'))
  const pageSize = (PAGE_SIZE_OPTIONS as ReadonlyArray<number>).includes(pageSizeRaw)
    ? pageSizeRaw
    : DEFAULT_PAGE_SIZE
  const totalCount = sortedAccounts.length
  const page = Math.min(
    Math.max(1, Number(searchParams.get('page')) || 1),
    Math.max(1, Math.ceil(totalCount / pageSize)),
  )
  const pagedAccounts = useMemo(
    () => sortedAccounts.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
    [sortedAccounts, page, pageSize],
  )

  const allOnPage = useMemo(() => pagedAccounts.map((a) => a.id), [pagedAccounts])
  const allSelected = allOnPage.length > 0 && allOnPage.every((id) => selected.has(id))
  const someArchived = useMemo(
    () => pagedAccounts.some((a) => selected.has(a.id) && a.archived),
    [pagedAccounts, selected],
  )

  function toggleAll(next: boolean) {
    setSelected(next ? new Set(allOnPage) : new Set())
  }

  function toggleOne(id: string, next: boolean) {
    setSelected((prev) => {
      const updated = new Set(prev)
      if (next) updated.add(id)
      else updated.delete(id)
      return updated
    })
  }

  async function afterBulk() {
    setSelected(new Set())
    await utils.businessAccount.list.invalidate()
    router.refresh()
  }

  async function run(label: string, fn: () => Promise<{ count: number }>) {
    setBusy(true)
    try {
      const { count } = await fn()
      toast.success(`${label} ${count} account${count === 1 ? '' : 's'}`)
      await afterBulk()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not ${label.toLowerCase()}`)
    } finally {
      setBusy(false)
    }
  }

  const ids = () => Array.from(selected)

  async function onArchive(restore: boolean) {
    await run(restore ? 'Restored' : 'Archived', () =>
      bulkArchive.mutateAsync({ ids: ids(), restore }),
    )
  }

  async function onDelete() {
    const n = selected.size
    const ok = await confirm({
      title: `Permanently delete ${n} account${n === 1 ? '' : 's'}?`,
      body: 'This also removes their linked contacts, students, labels and uploaded invoices. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    await run('Deleted', () => bulkDelete.mutateAsync({ ids: ids() }))
  }

  async function onSetStatus(status: Status) {
    await run('Updated', () => bulkSetStatus.mutateAsync({ ids: ids(), status }))
  }

  async function onSetLabel(labelId: string, remove: boolean) {
    await run(remove ? 'Unlabelled' : 'Labelled', () =>
      bulkSetLabel.mutateAsync({ ids: ids(), labelId, remove }),
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField placeholder="Search by name, city, email…" />
          <FacetedFilter
            paramKey="status"
            label="Status"
            multiple
            options={[
              { value: 'prospect', label: 'Prospect' },
              { value: 'active', label: 'Active' },
              { value: 'paused', label: 'Paused' },
              { value: 'churned', label: 'Churned' },
            ]}
          />
          {labels.length > 0 && (
            <FacetedFilter
              paramKey="labelIds"
              label="Label"
              multiple
              options={labels.map((l) => ({
                value: l.id,
                label: l.name,
                color: l.color ?? undefined,
              }))}
            />
          )}
          <SortMenu options={ACCOUNT_SORT_OPTIONS} defaultValue="name" align="start" />
          <PageSizeSelect defaultValue={DEFAULT_PAGE_SIZE} options={PAGE_SIZE_OPTIONS} />
        </div>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            New {kind === 'school' ? 'school' : 'B2B partner'}
          </Button>
        )}
      </div>

      {/* Bulk-actions bar — appears when at least one row is selected. Manager+
          only; the server re-checks every mutation (CLAUDE.md §20, §27). */}
      {canManage && selected.size > 0 && (
        <Toolbar
          label={`${selected.size} selected`}
          clear={
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs font-medium text-primary-700 hover:underline"
            >
              Clear selection
            </button>
          }
        >
          <BulkMenu label="Set status" disabled={busy}>
            {(close) =>
              STATUS_OPTIONS.map((s) => (
                <BulkMenuItem
                  key={s.value}
                  onClick={() => {
                    close()
                    void onSetStatus(s.value)
                  }}
                >
                  {s.label}
                </BulkMenuItem>
              ))
            }
          </BulkMenu>

          {labels.length > 0 && (
            <BulkMenu label="Label" disabled={busy}>
              {(close) => (
                <>
                  <p className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    Add label
                  </p>
                  {labels.map((l) => (
                    <BulkMenuItem
                      key={l.id}
                      onClick={() => {
                        close()
                        void onSetLabel(l.id, false)
                      }}
                    >
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 flex-none rounded-full"
                        style={{ backgroundColor: l.color ?? '#94a3b8' }}
                      />
                      {l.name}
                    </BulkMenuItem>
                  ))}
                  <div className="my-1 border-t border-neutral-100" />
                  <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    Remove label
                  </p>
                  {labels.map((l) => (
                    <BulkMenuItem
                      key={`rm-${l.id}`}
                      onClick={() => {
                        close()
                        void onSetLabel(l.id, true)
                      }}
                    >
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 flex-none rounded-full opacity-40"
                        style={{ backgroundColor: l.color ?? '#94a3b8' }}
                      />
                      {l.name}
                    </BulkMenuItem>
                  ))}
                </>
              )}
            </BulkMenu>
          )}

          {someArchived ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onArchive(true)}
            >
              Restore
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onArchive(false)}
            >
              Archive
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onDelete}
          >
            Delete
          </Button>
        </Toolbar>
      )}

      {creating && (
        <AccountCreateForm
          kind={kind}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            router.refresh()
          }}
        />
      )}

      {accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200 bg-white px-10 py-14 text-center shadow-card">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100">
            <BuildingIcon size={18} className="text-neutral-400" />
          </div>
          <p className="text-sm font-medium text-neutral-800">
            No {kind === 'school' ? 'schools' : 'B2B partners'} yet.
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-neutral-500">
            Click <em>New {kind === 'school' ? 'school' : 'B2B partner'}</em> to add one, or pull
            existing customers from the invoicing platform in <em>Settings → Invoicing</em>.
          </p>
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            {/* Sticky thead — same treatment as the Contacts table so column
                headings stay visible while the agent scrolls a long list. */}
            <thead className="sticky top-0 z-10 bg-neutral-50/95 text-left backdrop-blur supports-[backdrop-filter]:bg-neutral-50/80">
              <tr className="border-b border-neutral-200">
                {canManage && (
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                      checked={allSelected}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </th>
                )}
                <SortableTh
                  label={kind === 'school' ? 'School' : 'B2B Partner'}
                  sortKey="name"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Email
                </th>
                <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Phone
                </th>
                <SortableTh
                  label="Students"
                  sortKey="studentCount"
                  align="right"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <SortableTh
                  label="Hours"
                  sortKey="hoursContracted"
                  align="right"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <SortableTh
                  label="Activity"
                  sortKey="activity"
                  align="center"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <SortableTh
                  label="Paid"
                  sortKey="amountPaidMinor"
                  align="right"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <SortableTh
                  label="Last contact"
                  sortKey="lastContactedAt"
                  align="right"
                  active={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {pagedAccounts.map((a) => {
                const isSelected = selected.has(a.id)
                return (
                <tr
                  key={a.id}
                  className={
                    isSelected
                      ? 'group bg-primary-50/40 transition-colors hover:bg-primary-50/60'
                      : 'group transition-colors hover:bg-neutral-50/80'
                  }
                >
                  {canManage && (
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select ${a.name}`}
                        className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                        checked={isSelected}
                        onChange={(e) => toggleOne(a.id, e.target.checked)}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 align-top">
                    <Link href={`/accounts/${a.id}`} className="block min-w-0">
                      <span className="flex items-center gap-1.5">
                        {a.color && (
                          <span
                            aria-hidden
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: a.color }}
                          />
                        )}
                        <span className="truncate font-medium text-neutral-900 group-hover:text-primary-700">
                          {a.name}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[a.status]}`}
                        >
                          {a.status}
                        </span>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-neutral-500">
                        {a.city && <span>{[a.city, a.country].filter(Boolean).join(', ')}</span>}
                        {a.companies.slice(0, 3).map((c) => (
                          <span
                            key={c.id}
                            aria-hidden
                            title={c.name}
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: c.color ?? '#94a3b8' }}
                          />
                        ))}
                      </span>
                      {a.labels.length > 0 && (
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          {a.labels.map((l) => (
                            <span
                              key={l.id}
                              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${l.color ?? '#94a3b8'}1a`,
                                color: l.color ?? '#475569',
                              }}
                            >
                              <span
                                aria-hidden
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: l.color ?? '#94a3b8' }}
                              />
                              {l.name}
                            </span>
                          ))}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    <EmailLink email={a.contactEmail} />
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    <PhoneLink phone={a.contactPhone} />
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-700">
                    {a.studentCount}
                  </td>
                  <td
                    className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-700"
                    title={`${a.hoursDelivered}h delivered of ${a.hoursContracted}h contracted`}
                  >
                    {a.hoursContracted > 0 ? `${a.hoursContracted}h` : '—'}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex items-center justify-center gap-2 text-xs tabular-nums text-neutral-600">
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${a.callCount} calls`}
                      >
                        <PhoneIcon size={12} className="text-neutral-400" />
                        {a.callCount}
                      </span>
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${a.textCount} messages`}
                      >
                        <MessageSquareIcon size={12} className="text-neutral-400" />
                        {a.textCount}
                      </span>
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${a.emailCount} emails`}
                      >
                        <MailIcon size={12} className="text-neutral-400" />
                        {a.emailCount}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-700">
                    {a.amountPaidMinor > 0 ? formatMoneyMinor(a.amountPaidMinor) : '—'}
                  </td>
                  <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-500">
                    {a.lastContactedAt ? formatRelativeTime(new Date(a.lastContactedAt), now) : '—'}
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    <Link
                      href={`/accounts/${a.id}`}
                      aria-label={`Open ${a.name}`}
                      className="inline-flex text-neutral-300 transition-colors group-hover:text-primary-600"
                    >
                      <ChevronRightIcon size={16} />
                    </Link>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      {accounts.length > 0 && (
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={totalCount}
          shown={pagedAccounts.length}
        />
      )}
    </div>
  )
}

/** A clickable, sortable table header cell. Shows a ▲/▼ caret on the active
 *  column. Keyboard-accessible (it's a real button). */
function SortableTh({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string
  sortKey: SortKey
  active: SortKey
  dir: 'asc' | 'desc'
  onSort: (key: SortKey) => void
  align?: 'left' | 'right' | 'center'
}) {
  const isActive = active === sortKey
  const alignClass =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  return (
    <th
      className={`px-3 py-2 font-medium text-neutral-600 ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`group/sort inline-flex w-full items-center gap-1 ${alignClass} hover:text-neutral-900`}
        aria-label={`Sort by ${label}`}
      >
        <span>{label}</span>
        <span
          aria-hidden
          className={`text-[9px] leading-none ${isActive ? 'text-primary-600' : 'text-neutral-300 group-hover/sort:text-neutral-400'}`}
        >
          {isActive ? (dir === 'asc' ? '▲' : '▼') : '▲'}
        </span>
      </button>
    </th>
  )
}

export function describeStatusToneClass(status: Status): string {
  return STATUS_TONE[status]
}

/** A dropdown button for the bulk toolbar — a labelled secondary-button trigger
 *  that opens a menu of choices. Mirrors the FacetedFilter chevron affordance. */
function BulkMenu({
  label,
  disabled,
  children,
}: {
  label: string
  disabled?: boolean
  children: (close: () => void) => ReactNode
}) {
  return (
    <Popover
      align="start"
      triggerClassName={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1',
        disabled && 'pointer-events-none opacity-50',
      )}
      trigger={
        <>
          <span>{label}</span>
          <ChevronDownIcon size={14} className="text-neutral-400" aria-hidden />
        </>
      }
    >
      {(close) => (
        <div className="max-h-72 min-w-[12rem] overflow-y-auto">{children(close)}</div>
      )}
    </Popover>
  )
}

function BulkMenuItem({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none"
    >
      {children}
    </button>
  )
}

// Re-export of `toast` so the unused-imports rule doesn't fight modules
// that import it from this file.
void toast
