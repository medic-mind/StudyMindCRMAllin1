// Client island for the Summer Camp bookings workspace. One cached live-feed
// query drives the table (placeholderData keeps rows on screen between filter
// changes); row expansion opens the editor panel — booking fields, camp
// assignment, notes — whose mutations write back to the camp app.

'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { trpc, type RouterOutputs } from '@/lib/trpc/client'

type Status = 'pending' | 'confirmed' | 'cancelled' | 'waitlist'
const STATUSES: Status[] = ['confirmed', 'pending', 'waitlist', 'cancelled']

const STATUS_TONE: Record<string, BadgeTone> = {
  confirmed: 'success',
  pending: 'warn',
  waitlist: 'info',
  cancelled: 'danger',
}

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

export function BookingsWorkspace({ canEdit, canCancel }: { canEdit: boolean; canCancel: boolean }) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState<Status | ''>('')
  const [campId, setCampId] = useState('')
  const [unassigned, setUnassigned] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  // Debounce the search so we don't re-pull the live feed per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const input = {
    ...(debounced ? { search: debounced } : {}),
    ...(status ? { status } : {}),
    ...(campId ? { campId } : {}),
    ...(unassigned ? { unassigned: true } : {}),
  }
  const list = trpc.summerCamp.bookings.list.useQuery(input, {
    placeholderData: (prev) => prev,
    refetchOnWindowFocus: false,
  })
  const camps = trpc.summerCamp.camps.useQuery(undefined, { refetchOnWindowFocus: false })
  const campOptions = camps.data?.feed?.camps ?? []

  if (list.data && !list.data.connected) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-medium text-neutral-800">Summer Camp app not connected</p>
        <p className="mt-1 text-sm text-neutral-500">
          Set <code className="rounded bg-neutral-100 px-1">SUMMER_CAMP_API_URL</code> and{' '}
          <code className="rounded bg-neutral-100 px-1">SUMMER_CAMP_API_KEY</code> to work bookings
          from the CRM.
        </p>
      </Card>
    )
  }

  const items = list.data?.items ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search student, guardian, camp, subject…"
          className="w-72"
          aria-label="Search bookings"
        />
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status | '')}
          className="w-40"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select
          value={campId}
          onChange={(e) => setCampId(e.target.value)}
          className="w-56"
          aria-label="Filter by camp"
        >
          <option value="">All camps</option>
          {campOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-neutral-600">
          <input
            type="checkbox"
            checked={unassigned}
            onChange={(e) => setUnassigned(e.target.checked)}
            className="h-4 w-4 rounded border-neutral-300"
          />
          Needs camp assignment
        </label>
        <span className="ml-auto text-sm text-neutral-500">
          {list.isFetching ? 'Refreshing…' : `${list.data?.total ?? 0} booking${(list.data?.total ?? 0) === 1 ? '' : 's'}`}
        </span>
      </div>

      {list.error ? (
        <Card className="p-6 text-center text-sm text-red-700">
          The live booking feed is unreachable: {list.error.message}. The camp app may be down —
          try again shortly.
        </Card>
      ) : items.length === 0 && !list.isLoading ? (
        <Card className="p-8 text-center text-sm text-neutral-500">
          No bookings match this view — clear a filter, or check the camp app if you expected new
          bookings here.
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
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
              {items.map((b) => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  open={openId === b.id}
                  onToggle={() => setOpenId(openId === b.id ? null : b.id)}
                  canEdit={canEdit}
                  canCancel={canCancel}
                  campOptions={campOptions}
                  refresh={() => void list.refetch()}
                />
              ))}
            </Tbody>
          </Table>
        </Card>
      )}
    </div>
  )
}

type BookingsList = RouterOutputs['summerCamp']['bookings']['list']
type Item = Extract<BookingsList, { connected: true }>['items'][number]

function BookingRow({
  booking: b,
  open,
  onToggle,
  canEdit,
  canCancel,
  campOptions,
  refresh,
}: {
  booking: Item
  open: boolean
  onToggle: () => void
  canEdit: boolean
  canCancel: boolean
  campOptions: { id: string; name: string }[]
  refresh: () => void
}) {
  return (
    <>
      <Tr
        className="cursor-pointer hover:bg-neutral-50"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Td className="font-medium text-neutral-900">{b.studentName ?? 'Unnamed'}</Td>
        <Td>
          <span className="block">{b.guardianName ?? '—'}</span>
          <span className="block text-xs text-neutral-400">{b.guardianEmail ?? ''}</span>
        </Td>
        <Td>{b.campName ?? <span className="text-amber-700">unassigned</span>}</Td>
        <Td>{b.subject ?? '—'}</Td>
        <Td>{b.weekLabel ?? (b.weekNumber ? `Week ${b.weekNumber}` : '—')}</Td>
        <Td className="whitespace-nowrap">
          {fmtDate(b.startDate)} – {fmtDate(b.endDate)}
        </Td>
        <Td>
          <Badge tone={STATUS_TONE[b.status ?? ''] ?? 'neutral'}>{b.status ?? 'unknown'}</Badge>
        </Td>
        <Td className="whitespace-nowrap text-right tabular-nums">
          {money(b.paidMinor)} / {money(b.totalMinor)}
        </Td>
      </Tr>
      {open ? (
        <Tr>
          <Td colSpan={8} className="bg-neutral-50/60 p-0">
            <BookingDetail
              booking={b}
              canEdit={canEdit}
              canCancel={canCancel}
              campOptions={campOptions}
              refresh={refresh}
            />
          </Td>
        </Tr>
      ) : null}
    </>
  )
}

function BookingDetail({
  booking: b,
  canEdit,
  canCancel,
  campOptions,
  refresh,
}: {
  booking: Item
  canEdit: boolean
  canCancel: boolean
  campOptions: { id: string; name: string }[]
  refresh: () => void
}) {
  const [status, setStatus] = useState<Status>((b.status as Status) ?? 'pending')
  const [subject, setSubject] = useState(b.subject ?? '')
  const [notes, setNotes] = useState(b.campNotes ?? '')
  const [assigned, setAssigned] = useState<string[]>(b.enrolledCampIds)
  const [note, setNote] = useState('')

  const update = trpc.summerCamp.bookings.update.useMutation({
    onSuccess: () => {
      toast.success('Saved and synced to the camp site')
      refresh()
    },
    onError: (err) => toast.error(err.message),
  })
  const assign = trpc.summerCamp.bookings.assignCamps.useMutation({
    onSuccess: () => {
      toast.success('Camp assignment saved on the camp site')
      refresh()
    },
    onError: (err) => toast.error(err.message),
  })
  const addNote = trpc.summerCamp.bookings.addNote.useMutation({
    onSuccess: () => {
      toast.success('Note added and shared with the camp site')
      setNote('')
      refresh()
    },
    onError: (err) => toast.error(err.message),
  })

  function toggleCamp(id: string) {
    setAssigned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function saveBooking() {
    if (status === 'cancelled' && b.status !== 'cancelled') {
      const sure = window.confirm(
        'This cancels the real booking on the camp site as well. Are you sure?',
      )
      if (!sure) return
    }
    update.mutate({
      bookingId: b.id,
      ...(status !== (b.status ?? 'pending') ? { status } : {}),
      ...(subject !== (b.subject ?? '') ? { subject } : {}),
      ...(notes !== (b.campNotes ?? '') ? { notes } : {}),
    })
  }

  const assignmentDirty = JSON.stringify(assigned) !== JSON.stringify(b.enrolledCampIds)

  return (
    <div className="grid gap-6 p-5 lg:grid-cols-3" onClick={(e) => e.stopPropagation()}>
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">People</h3>
        <dl className="mt-2 space-y-1.5 text-sm">
          {b.contacts.length > 0 ? (
            b.contacts.map((c) => (
              <div key={c.contactId}>
                <Link
                  href={`/contacts/${c.contactId}`}
                  className="font-medium text-primary-700 hover:underline"
                >
                  {c.name}
                </Link>
                <span className="ml-1.5 text-xs text-neutral-400">{c.kind}</span>
              </div>
            ))
          ) : (
            <p className="text-neutral-500">
              Not linked to a CRM contact yet — the next sync run links it automatically.
            </p>
          )}
        </dl>
        <dl className="mt-4 space-y-1.5 text-sm text-neutral-700">
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-400">Student email</dt>
            <dd>{b.studentEmail ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-400">Guardian</dt>
            <dd>
              {b.guardianName ?? '—'}
              {b.guardianPhone ? ` · ${b.guardianPhone}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-400">Dietary</dt>
            <dd>{b.dietaryRequirements ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-400">Emergency contact</dt>
            <dd>
              {b.emergencyContactName ?? '—'}
              {b.emergencyContactPhone ? ` · ${b.emergencyContactPhone}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-400">Payment (camp-owned)</dt>
            <dd className="tabular-nums">
              {money(b.paidMinor)} of {money(b.totalMinor)}
              {b.paymentType ? ` · ${b.paymentType}` : ''}
            </dd>
          </div>
          {b.withAccommodation ? <div className="text-neutral-600">Residential (accommodation)</div> : null}
        </dl>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Booking (syncs to camp)
        </h3>
        <div className="mt-2 space-y-3">
          <div>
            <label htmlFor={`st-${b.id}`} className="block text-xs font-medium text-neutral-600">
              Status
            </label>
            <Select
              id={`st-${b.id}`}
              value={status}
              disabled={!canEdit}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s} disabled={s === 'cancelled' && !canCancel}>
                  {s}
                  {s === 'cancelled' && !canCancel ? ' (Manager+)' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor={`sub-${b.id}`} className="block text-xs font-medium text-neutral-600">
              Subject
            </label>
            <Input
              id={`sub-${b.id}`}
              value={subject}
              disabled={!canEdit}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`bn-${b.id}`} className="block text-xs font-medium text-neutral-600">
              Booking notes (visible on the camp site)
            </label>
            <Textarea
              id={`bn-${b.id}`}
              rows={2}
              value={notes}
              disabled={!canEdit}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {canEdit ? (
            <Button size="sm" onClick={saveBooking} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save & sync to camp'}
            </Button>
          ) : (
            <p className="text-xs text-neutral-500">Your role is read-only for booking edits.</p>
          )}
        </div>

        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Camp assignment
        </h3>
        <div className="mt-2 space-y-1.5">
          {campOptions.length === 0 ? (
            <p className="text-sm text-neutral-500">Camp list unavailable right now.</p>
          ) : (
            campOptions.map((c) => {
              const idx = assigned.indexOf(c.id)
              return (
                <label key={c.id} className="flex items-center gap-2 text-sm text-neutral-700">
                  <input
                    type="checkbox"
                    disabled={!canEdit || assign.isPending}
                    checked={idx !== -1}
                    onChange={() => toggleCamp(c.id)}
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                  {c.name}
                  {idx === 0 ? (
                    <Badge tone="info" className="ml-1">
                      primary
                    </Badge>
                  ) : null}
                </label>
              )
            })
          )}
          {canEdit && campOptions.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-1"
              disabled={!assignmentDirty || assign.isPending}
              onClick={() => assign.mutate({ bookingId: b.id, campIds: assigned })}
            >
              {assign.isPending ? 'Assigning…' : 'Save assignment'}
            </Button>
          ) : null}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Notes (shared with the camp site)
        </h3>
        <div className="mt-2 space-y-2">
          <Textarea
            rows={2}
            value={note}
            placeholder="Add a note…"
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!note.trim() || addNote.isPending}
            onClick={() => addNote.mutate({ bookingId: b.id, body: note.trim() })}
          >
            {addNote.isPending ? 'Adding…' : 'Add note'}
          </Button>
        </div>
        {b.notesLog.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No notes yet — add the first note above.
          </p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {b.notesLog
              .slice()
              .reverse()
              .map((n) => (
                <li key={n.id} className="border-l-2 border-neutral-200 pl-2.5">
                  <p className="whitespace-pre-wrap text-sm text-neutral-700">{n.body}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    {n.createdAt ? fmtDate(n.createdAt) : ''} · {n.author ?? 'unknown'}
                    {n.source === 'crm' ? ' · CRM' : ''}
                  </p>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  )
}
