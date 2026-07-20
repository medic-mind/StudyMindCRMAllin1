'use client'

// Slide-over detail editor for one camp booking — keeps the list in context
// (the CRM's documented pattern for detail/edit) instead of the old inline
// row expansion. Every save goes to the camp app first, then refreshes the
// RSC list so the row reflects the change immediately.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SlideOver } from '@/components/ui/slide-over'
import { Textarea } from '@/components/ui/textarea'
import { trpc, type RouterOutputs } from '@/lib/trpc/client'

import { BookingStatusBadge } from '../camp-status'

export type BookingItem = RouterOutputs['summerCamp']['bookings']['list']['items'][number]

type Status = 'pending' | 'confirmed' | 'cancelled' | 'waitlist'
const STATUSES: Status[] = ['confirmed', 'pending', 'waitlist', 'cancelled']

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })
function money(minor: number | null): string {
  return minor === null ? '—' : gbp.format(minor / 100)
}
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500">
      {children}
    </h3>
  )
}

export function BookingSlideOver({
  item,
  closeHref,
  listYear,
  canEdit,
  canCancel,
}: {
  item: BookingItem | null
  closeHref: string
  listYear: number
  canEdit: boolean
  canCancel: boolean
}) {
  const router = useRouter()
  const close = () => router.push(closeHref, { scroll: false })

  return (
    <SlideOver
      open={item !== null}
      onClose={close}
      width="lg"
      title={item ? (item.studentName ?? 'Booking') : ''}
    >
      {item ? (
        <Detail item={item} listYear={listYear} canEdit={canEdit} canCancel={canCancel} />
      ) : null}
    </SlideOver>
  )
}

function Detail({
  item: b,
  listYear,
  canEdit,
  canCancel,
}: {
  item: BookingItem
  listYear: number
  canEdit: boolean
  canCancel: boolean
}) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>((b.status as Status) ?? 'pending')
  const [subject, setSubject] = useState(b.subject ?? '')
  const [notes, setNotes] = useState(b.campNotes ?? '')
  const [assigned, setAssigned] = useState<string[]>(b.enrolledCampIds)
  const [note, setNote] = useState('')

  const campsQuery = trpc.summerCamp.camps.useQuery(
    { year: b.campYear ?? listYear },
    { refetchOnWindowFocus: false },
  )
  const campOptions = campsQuery.data?.feed?.camps ?? []

  const update = trpc.summerCamp.bookings.update.useMutation({
    onSuccess: () => {
      toast.success('Saved and synced to the camp app')
      router.refresh()
    },
    onError: (err) => toast.error(err.message),
  })
  const assign = trpc.summerCamp.bookings.assignCamps.useMutation({
    onSuccess: () => {
      toast.success('Camp assignment saved')
      router.refresh()
    },
    onError: (err) => toast.error(err.message),
  })
  const addNote = trpc.summerCamp.bookings.addNote.useMutation({
    onSuccess: () => {
      toast.success('Note added and shared with the camp app')
      setNote('')
      router.refresh()
    },
    onError: (err) => toast.error(err.message),
  })

  function saveBooking() {
    if (status === 'cancelled' && b.status !== 'cancelled') {
      const sure = window.confirm('This cancels the real booking on the camp app as well. Are you sure?')
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <BookingStatusBadge status={b.status} />
        {b.campName ? <Badge tone="info">{b.campName}</Badge> : <Badge tone="warn">No camp assigned</Badge>}
        {b.campYear ? <Badge tone="neutral">{b.campYear}</Badge> : null}
        {b.withAccommodation ? <Badge tone="neutral">Residential</Badge> : null}
      </div>

      <section className="space-y-2">
        <SectionLabel>People</SectionLabel>
        {b.contacts.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {b.contacts.map((c) => (
              <li key={c.contactId}>
                <Link href={`/contacts/${c.contactId}`} className="font-medium text-primary-700 hover:underline">
                  {c.name}
                </Link>
                <span className="ml-1.5 text-xs text-neutral-400">{c.kind}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">Not linked to CRM contacts yet — the next sync links them.</p>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm text-neutral-700">
          <div>
            <dt className="text-xs text-neutral-400">Student email</dt>
            <dd>{b.studentEmail ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-400">Guardian</dt>
            <dd>
              {b.guardianName ?? '—'}
              {b.guardianPhone ? ` · ${b.guardianPhone}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-400">Dietary</dt>
            <dd>{b.dietaryRequirements ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-400">Emergency contact</dt>
            <dd>
              {b.emergencyContactName ?? '—'}
              {b.emergencyContactPhone ? ` · ${b.emergencyContactPhone}` : ''}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-neutral-400">Payment (camp-owned)</dt>
            <dd className="tabular-nums">
              {money(b.paidMinor)} of {money(b.totalMinor)}
              {b.paymentType ? ` · ${b.paymentType}` : ''}
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <SectionLabel>Booking — syncs to the camp app</SectionLabel>
        <div>
          <label htmlFor="bk-status" className="mb-1 block text-xs font-medium text-neutral-600">
            Status
          </label>
          <Select
            id="bk-status"
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
          <label htmlFor="bk-subject" className="mb-1 block text-xs font-medium text-neutral-600">
            Subject
          </label>
          <Input id="bk-subject" value={subject} disabled={!canEdit} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <label htmlFor="bk-notes" className="mb-1 block text-xs font-medium text-neutral-600">
            Booking notes (visible on the camp app)
          </label>
          <Textarea id="bk-notes" rows={2} value={notes} disabled={!canEdit} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {canEdit ? (
          <Button size="sm" onClick={saveBooking} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save & sync to camp'}
          </Button>
        ) : (
          <p className="text-xs text-neutral-500">Your role is read-only for booking edits.</p>
        )}
      </section>

      <section className="space-y-2">
        <SectionLabel>Camp assignment{b.campYear ? ` — ${b.campYear} season` : ''}</SectionLabel>
        {campsQuery.isLoading ? (
          <p className="text-sm text-neutral-500">Loading camps…</p>
        ) : campOptions.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No camps available for this season — check the camp app connection.
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {campOptions.map((c) => {
                const idx = assigned.indexOf(c.id)
                return (
                  <li key={c.id}>
                    <label className="flex items-center gap-2 text-sm text-neutral-700">
                      <input
                        type="checkbox"
                        disabled={!canEdit || assign.isPending}
                        checked={idx !== -1}
                        onChange={() =>
                          setAssigned((prev) =>
                            prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                          )
                        }
                        className="h-4 w-4 rounded border-neutral-300"
                      />
                      {c.name}
                      {idx === 0 ? <Badge tone="info">primary</Badge> : null}
                    </label>
                  </li>
                )
              })}
            </ul>
            {canEdit ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!assignmentDirty || assign.isPending}
                onClick={() => assign.mutate({ bookingId: b.id, campIds: assigned })}
              >
                {assign.isPending ? 'Assigning…' : 'Save assignment'}
              </Button>
            ) : null}
          </>
        )}
      </section>

      <section className="space-y-2">
        <SectionLabel>Notes — shared with the camp app</SectionLabel>
        <Textarea rows={2} value={note} placeholder="Add a note…" onChange={(e) => setNote(e.target.value)} />
        <Button
          size="sm"
          disabled={!note.trim() || addNote.isPending}
          onClick={() => addNote.mutate({ bookingId: b.id, body: note.trim() })}
        >
          {addNote.isPending ? 'Adding…' : 'Add note'}
        </Button>
        {b.notesLog.length === 0 ? (
          <p className="text-sm text-neutral-500">No notes yet.</p>
        ) : (
          <ul className="space-y-2.5">
            {b.notesLog
              .slice()
              .reverse()
              .map((n) => (
                <li key={n.id} className="border-l-2 border-neutral-200 pl-2.5">
                  <p className="whitespace-pre-wrap text-sm text-neutral-700">{n.body}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    {fmtDateTime(n.created_at ?? n.createdAt)} · {n.author ?? 'unknown'}
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
