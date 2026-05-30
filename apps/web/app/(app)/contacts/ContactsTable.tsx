// Rich client-side contacts table. Dense by design (CLAUDE.md §4): one row
// surfaces the contact, clickable email + phone, booking status, the
// call/text/email counts from their timeline, booking-derived hours / last
// lesson / spend, and last-contacted. Multi-select drives the bulk-actions
// bar (merge, soft delete, Mailchimp push).
//
// Family is intentionally not a column or filter here — contacts are students
// or parents/guardians, linked via contact relations, not grouped into a
// Family in this surface (product direction, May 2026).
//
// CLAUDE.md §27 — bulk procedures gate on role server-side; the bar just
// reflects what the user is allowed to do.

'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ChevronRightIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
} from '@/components/ui/icon'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { formatMoneyMinor } from '@/lib/format/money'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

type SortBy = 'createdAt' | 'name'
type SortDir = 'asc' | 'desc'

type BookingStatus = 'lead' | 'registered_no_hours' | 'registered_with_hours'

interface ContactRow {
  id: string
  displayName: string
  email: string | null
  phoneE164: string | null
  kind: string
  companies: ReadonlyArray<{ id: string; name: string; color: string | null }>
  bookingStatus: BookingStatus
  hoursBooked: number | null
  lastLessonAt: Date | string | null
  amountSpentMinor: number | null
  callCount: number
  emailCount: number
  textCount: number
  lastInteractionAt: Date | string | null
  createdAt: Date | string
}

interface Props {
  rows: ReadonlyArray<ContactRow>
  /** Cursor for the next page, when one exists. */
  nextCursor: { id: string; createdAt: string } | null
  /** Current filter state (echoed back in pagination links). */
  baseQuery: Record<string, string>
  /** Current role — drives which bulk actions render. */
  role: string
}

const KIND_TONE: Record<string, BadgeTone> = {
  parent: 'info',
  student: 'accent',
  tutor: 'success',
  other: 'neutral',
}
const KIND_RING: Record<string, string> = {
  parent: 'ring-primary-100',
  student: 'ring-violet-100',
  tutor: 'ring-emerald-100',
  other: 'ring-neutral-100',
}

const BOOKING_STATUS: Record<
  BookingStatus,
  { label: string; tone: BadgeTone; title: string }
> = {
  lead: {
    label: 'Lead',
    tone: 'neutral',
    title: 'Not registered on the booking site yet',
  },
  registered_no_hours: {
    label: 'Registered',
    tone: 'info',
    title: 'Registered on the booking site but has not booked hours',
  },
  registered_with_hours: {
    label: 'Booked hours',
    tone: 'success',
    title: 'Registered on the booking site and has booked hours',
  },
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ')
}

const CAN_DELETE = new Set(['ceo', 'senior_manager', 'manager'])
const CAN_PUSH = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

export function ContactsTable({ rows, nextCursor, baseQuery, role }: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const canDelete = CAN_DELETE.has(role)
  const canPush = CAN_PUSH.has(role)
  const canMerge = CAN_DELETE.has(role) // same tier as delete: Manager+

  const bulkMerge = trpc.contact.bulkMerge.useMutation()

  async function onBulkMerge() {
    const ids = Array.from(selected)
    if (ids.length < 2) {
      toast.error('Select at least two contacts to merge.')
      return
    }
    // Survivor = the first selected row in display order; the rest merge
    // into it. We confirm by name so the agent knows what survives.
    const orderedSelected = rows.filter((r) => selected.has(r.id))
    const survivor = orderedSelected[0]
    if (!survivor) {
      toast.error('Could not resolve a survivor on this page.')
      return
    }
    const loserIds = ids.filter((id) => id !== survivor.id)
    if (
      !confirm(
        `Merge ${loserIds.length} contact${loserIds.length === 1 ? '' : 's'} into ` +
          `"${survivor.displayName}"? The others are soft-deleted and their ` +
          `history is re-parented onto ${survivor.displayName}. This cannot be ` +
          `auto-undone.`,
      )
    )
      return
    setBusy(true)
    try {
      const result = await bulkMerge.mutateAsync({
        survivorId: survivor.id,
        loserIds,
      })
      const failed = result.results.filter((r) => r.status === 'failed').length
      toast.success(
        `Merged ${result.mergedCount} into ${survivor.displayName}` +
          (failed > 0 ? ` · ${failed} failed` : ''),
      )
      setSelected(new Set())
      await utils.contact.list.invalidate()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Merge failed')
    } finally {
      setBusy(false)
    }
  }

  const allOnPage = useMemo(() => rows.map((r) => r.id), [rows])
  const allSelected = allOnPage.length > 0 && allOnPage.every((id) => selected.has(id))

  function toggleAll(next: boolean) {
    const updated = new Set(selected)
    for (const id of allOnPage) {
      if (next) updated.add(id)
      else updated.delete(id)
    }
    setSelected(updated)
  }

  function toggleOne(id: string, next: boolean) {
    const updated = new Set(selected)
    if (next) updated.add(id)
    else updated.delete(id)
    setSelected(updated)
  }

  const bulkDelete = trpc.contact.bulkSoftDelete.useMutation()
  const bulkPush = trpc.contact.bulkMailchimpPush.useMutation()

  async function onBulkDelete() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    if (
      !confirm(
        `Soft-delete ${ids.length} contact${ids.length === 1 ? '' : 's'}? ` +
          `They can be restored from audit within the 30-day grace window.`,
      )
    )
      return
    setBusy(true)
    try {
      const result = await bulkDelete.mutateAsync({ contactIds: ids })
      toast.success(`Deleted ${result.deletedCount} contact${result.deletedCount === 1 ? '' : 's'}`)
      setSelected(new Set())
      await utils.contact.list.invalidate()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }

  async function onBulkPush() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    setBusy(true)
    try {
      const result = await bulkPush.mutateAsync({ contactIds: ids })
      const failed = result.results.filter((r) => r.status === 'failed').length
      const skipped = result.results.filter((r) => r.status === 'skipped').length
      toast.success(
        `Pushed ${result.pushedCount} to Mailchimp · ` +
          `${failed} failed · ${skipped} skipped`,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Push failed')
    } finally {
      setBusy(false)
    }
  }

  const now = new Date()
  const sortBy = (baseQuery.sortBy as SortBy) ?? 'createdAt'
  const sortDir = (baseQuery.sortDir as SortDir) ?? 'desc'

  function sortHref(field: SortBy): string {
    const params = new URLSearchParams(baseQuery)
    params.set('sortBy', field)
    if (sortBy === field) {
      params.set('sortDir', sortDir === 'desc' ? 'asc' : 'desc')
    } else {
      params.set('sortDir', field === 'name' ? 'asc' : 'desc')
    }
    return `/contacts?${params.toString()}`
  }

  function sortGlyph(field: SortBy) {
    if (sortBy !== field) return null
    return (
      <span className="ml-1 text-neutral-400" aria-hidden>
        {sortDir === 'desc' ? '↓' : '↑'}
      </span>
    )
  }

  return (
    <div className="mt-4 space-y-3">
      {/* Bulk-actions bar — appears when at least one row is selected. */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm">
          <span className="font-medium text-primary-800">
            {selected.size} selected
          </span>
          <span className="text-neutral-400">·</span>
          {canPush && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={onBulkPush}
            >
              Push to Mailchimp
            </Button>
          )}
          {canMerge && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || selected.size < 2}
              onClick={onBulkMerge}
              title={
                selected.size < 2
                  ? 'Select two or more to merge'
                  : 'Merge into the first selected contact'
              }
            >
              Merge
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={onBulkDelete}
            >
              Delete
            </Button>
          )}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-neutral-600 hover:underline"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-card">
        {rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-neutral-700">
              No contacts match these filters.
            </p>
          </div>
        ) : (
          <table className="w-full min-w-[1100px] border-collapse text-sm">
            <thead className="bg-neutral-50 text-left">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                    checked={allSelected}
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                </th>
                <th className="px-3 py-2 font-medium text-neutral-600">
                  <Link href={sortHref('name')} className="hover:text-neutral-900">
                    Contact{sortGlyph('name')}
                  </Link>
                </th>
                <th className="px-3 py-2 font-medium text-neutral-600">Email</th>
                <th className="px-3 py-2 font-medium text-neutral-600">Phone</th>
                <th className="px-3 py-2 font-medium text-neutral-600">Status</th>
                <th className="px-3 py-2 text-center font-medium text-neutral-600">
                  Activity
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Hours
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Last lesson
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Spent
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  Last contact
                </th>
                <th className="px-3 py-2 text-right font-medium text-neutral-600">
                  <Link href={sortHref('createdAt')} className="hover:text-neutral-900">
                    Added{sortGlyph('createdAt')}
                  </Link>
                </th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((c) => {
                const tone = KIND_TONE[c.kind] ?? 'neutral'
                const ring = KIND_RING[c.kind] ?? 'ring-neutral-100'
                const isSelected = selected.has(c.id)
                const status = BOOKING_STATUS[c.bookingStatus]
                return (
                  <tr
                    key={c.id}
                    className={`group ${isSelected ? 'bg-primary-50/40' : ''}`}
                  >
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.displayName}`}
                        className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                        checked={isSelected}
                        onChange={(e) => toggleOne(c.id, e.target.checked)}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Link
                        href={`/contacts/${c.id}`}
                        className="flex min-w-0 items-center gap-2.5"
                      >
                        <Avatar
                          name={c.displayName}
                          size={32}
                          className={`ring-2 ${ring}`}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-neutral-900 group-hover:text-primary-700">
                            {c.displayName}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5">
                            <Badge tone={tone}>{formatKind(c.kind)}</Badge>
                            {c.companies.slice(0, 3).map((cc) => (
                              <span
                                key={cc.id}
                                aria-hidden
                                title={cc.name}
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: cc.color ?? '#94a3b8' }}
                              />
                            ))}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 align-top text-xs">
                      <EmailLink email={c.email} />
                    </td>
                    <td className="px-3 py-2 align-top text-xs">
                      <PhoneLink phone={c.phoneE164} />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge tone={status.tone} >
                        <span title={status.title}>{status.label}</span>
                      </Badge>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center justify-center gap-2 text-xs tabular-nums text-neutral-600">
                        <span
                          className="inline-flex items-center gap-0.5"
                          title={`${c.callCount} calls`}
                        >
                          <PhoneIcon size={12} className="text-neutral-400" />
                          {c.callCount}
                        </span>
                        <span
                          className="inline-flex items-center gap-0.5"
                          title={`${c.textCount} messages`}
                        >
                          <MessageSquareIcon size={12} className="text-neutral-400" />
                          {c.textCount}
                        </span>
                        <span
                          className="inline-flex items-center gap-0.5"
                          title={`${c.emailCount} emails`}
                        >
                          <MailIcon size={12} className="text-neutral-400" />
                          {c.emailCount}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-600">
                      {c.hoursBooked != null ? `${c.hoursBooked}h` : '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-500">
                      {c.lastLessonAt
                        ? formatRelativeTime(new Date(c.lastLessonAt), now)
                        : '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-700">
                      {c.amountSpentMinor != null
                        ? formatMoneyMinor(c.amountSpentMinor)
                        : '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-500">
                      {c.lastInteractionAt
                        ? formatRelativeTime(new Date(c.lastInteractionAt), now)
                        : '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-500">
                      {formatRelativeTime(new Date(c.createdAt), now)}
                    </td>
                    <td className="px-3 py-2 align-top text-right">
                      <Link
                        href={`/contacts/${c.id}`}
                        aria-label={`Open ${c.displayName}`}
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
        )}
      </div>

      {nextCursor && (
        <div className="flex justify-end">
          <Link
            href={{
              pathname: '/contacts',
              query: {
                ...baseQuery,
                cursorId: nextCursor.id,
                cursorAt: nextCursor.createdAt,
              },
            }}
          >
            <Button variant="secondary">Next page</Button>
          </Link>
        </div>
      )}
    </div>
  )
}
