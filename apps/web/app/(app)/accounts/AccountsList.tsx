// Client island for the B2B accounts list. Dense table (CLAUDE.md §4) with
// inline status filter + live search + create button. Each row surfaces the
// org, clickable email + phone, student count + contracted hours, the
// call/text/email counts across the account's linked contacts, amount paid
// (paid uploaded invoices), and when we last contacted them.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  BuildingIcon,
  ChevronRightIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
} from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { formatMoneyMinor } from '@/lib/format/money'
import { formatRelativeTime } from '@/lib/format/relative-time'

import { AccountCreateForm } from './AccountCreateForm'

type Kind = 'school' | 'partnership'
type Status = 'prospect' | 'active' | 'paused' | 'churned'

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

export function AccountsList({ kind, accounts }: { kind: Kind; accounts: AccountRow[] }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [creating, setCreating] = useState(false)
  const [q, setQ] = useState(searchParams.get('q') ?? '')
  const status = (searchParams.get('status') ?? '') as Status | ''
  const now = new Date()

  // Client-side column sort — the page already holds every row in memory, so
  // sorting is instant and needs no round-trip. Name defaults ascending;
  // numeric/recency columns default to "most first" (descending).
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  const sortedAccounts = [...accounts].sort((a, b) => {
    const av = sortValue(a, sortKey)
    const bv = sortValue(b, sortKey)
    let cmp: number
    if (typeof av === 'string' && typeof bv === 'string') {
      cmp = av.localeCompare(bv)
    } else {
      cmp = (av as number) - (bv as number)
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  function pushParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value && value.length > 0) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    router.push(`/accounts?${params.toString()}`)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              pushParam('q', q.trim() || null)
            }}
          >
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, city, email…"
              className="w-72"
              aria-label="Search accounts"
            />
          </form>
          <Select
            value={status}
            onChange={(e) => pushParam('status', e.target.value || null)}
            aria-label="Status filter"
          >
            <option value="">All statuses</option>
            <option value="prospect">Prospect</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="churned">Churned</option>
          </Select>
        </div>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            New {kind === 'school' ? 'school' : 'B2B partner'}
          </Button>
        )}
      </div>

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
              {sortedAccounts.map((a) => (
                <tr key={a.id} className="group transition-colors hover:bg-neutral-50/80">
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
              ))}
            </tbody>
          </table>
        </Card>
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

// Re-export of `toast` so the unused-imports rule doesn't fight modules
// that import it from this file.
void toast
