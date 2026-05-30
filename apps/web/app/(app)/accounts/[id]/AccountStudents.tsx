// Students panel for a BusinessAccount detail page. Lists the cohort the
// school / partnership is sending us, what they're getting, and the
// hours-contracted vs hours-delivered split that the
// booking.studymind.co.uk sync will eventually update (CLAUDE.md §15).
//
// Manager+ writes; everyone reads. The "Sync hours" button calls the
// router stub today — the real pull lands in a follow-up PR.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Status = 'active' | 'paused' | 'completed' | 'withdrawn'

interface Student {
  id: string
  accountId: string
  firstName: string
  lastName: string | null
  yearGroup: string | null
  dateOfBirth: Date | string | null
  program: string | null
  hoursContracted: number | null
  hoursDelivered: number | null
  startDate: Date | string | null
  endDate: Date | string | null
  status: Status
  subjects: string | null
  notes: string | null
  bookingStudentId: string | null
  bookingLastSyncAt: Date | string | null
  archived: boolean
}

const STATUS_TONE: Record<Status, string> = {
  active: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  paused: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  completed: 'bg-blue-50 text-blue-800 ring-1 ring-blue-200',
  withdrawn: 'bg-red-50 text-red-700 ring-1 ring-red-200',
}

function fullName(s: Student): string {
  return [s.firstName, s.lastName].filter(Boolean).join(' ').trim()
}

function formatDate(d: Date | string | null): string {
  if (!d) return ''
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(d))
}

function isoDate(d: Date | string | null | undefined): string {
  if (!d) return ''
  return new Date(d).toISOString().slice(0, 10)
}

export function AccountStudents({ accountId }: { accountId: string }) {
  const router = useRouter()
  const listQuery = trpc.businessAccount.students.list.useQuery({
    accountId,
    includeArchived: false,
  })
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const students = (listQuery.data ?? []) as Student[]

  const totals = students.reduce(
    (acc, s) => ({
      contracted: acc.contracted + (s.hoursContracted ?? 0),
      delivered: acc.delivered + (s.hoursDelivered ?? 0),
    }),
    { contracted: 0, delivered: 0 },
  )

  return (
    <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">Students</h2>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            + Add student
          </Button>
        )}
      </div>

      {students.length > 0 && (
        <div className="flex flex-wrap gap-3 text-xs text-neutral-600">
          <span>
            Hours contracted:{' '}
            <strong className="text-neutral-900">{totals.contracted}</strong>
          </span>
          <span>
            Hours delivered:{' '}
            <strong className="text-neutral-900">{totals.delivered}</strong>
          </span>
        </div>
      )}

      {creating && (
        <StudentEditor
          mode="create"
          accountId={accountId}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false)
            await listQuery.refetch()
            router.refresh()
          }}
        />
      )}

      {listQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : students.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No students yet. Click <em>+ Add student</em> to track the first
          cohort.
        </p>
      ) : (
        <ul className="space-y-2">
          {students.map((s) =>
            editingId === s.id ? (
              <li key={s.id}>
                <StudentEditor
                  mode="edit"
                  accountId={accountId}
                  student={s}
                  onClose={() => setEditingId(null)}
                  onSaved={async () => {
                    setEditingId(null)
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ) : (
              <li
                key={s.id}
                className="rounded-md border border-neutral-200 p-3 text-sm"
              >
                <StudentRow
                  student={s}
                  onEdit={() => setEditingId(s.id)}
                  onChanged={async () => {
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function StudentRow({
  student,
  onEdit,
  onChanged,
}: {
  student: Student
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const archive = trpc.businessAccount.students.archive.useMutation()
  const sync = trpc.businessAccount.students.syncFromBooking.useMutation()
  const [busy, setBusy] = useState(false)

  async function onArchive() {
    if (!confirm(`Archive ${fullName(student)}?`)) return
    setBusy(true)
    try {
      await archive.mutateAsync({ id: student.id })
      toast.success('Student archived')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not archive')
    } finally {
      setBusy(false)
    }
  }

  async function onSync() {
    setBusy(true)
    try {
      const result = await sync.mutateAsync({ id: student.id })
      if (result.status === 'not_implemented') {
        toast(result.message)
      } else {
        toast.success('Hours synced from booking site')
      }
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-neutral-900">
            {fullName(student)}
          </span>
          {student.yearGroup && (
            <span className="text-xs text-neutral-500">{student.yearGroup}</span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[student.status]}`}
          >
            {student.status}
          </span>
        </div>
        {student.program && (
          <p className="mt-0.5 text-xs text-neutral-700">{student.program}</p>
        )}
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
          {student.hoursContracted != null && (
            <span>
              <strong className="text-neutral-700">{student.hoursDelivered ?? 0}</strong>{' '}
              / {student.hoursContracted} h delivered
            </span>
          )}
          {student.subjects && <span>{student.subjects}</span>}
          {student.startDate && <span>From {formatDate(student.startDate)}</span>}
          {student.endDate && <span>to {formatDate(student.endDate)}</span>}
          {student.bookingLastSyncAt && (
            <span>Synced {formatDate(student.bookingLastSyncAt)}</span>
          )}
        </div>
        {student.notes && (
          <p className="mt-1 text-xs text-neutral-600">{student.notes}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="text-xs text-neutral-700 hover:underline"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={busy}
          title="Pulls hoursDelivered from booking.studymind.co.uk (wired later)."
          className="text-xs text-primary-700 hover:underline"
        >
          Sync hours
        </button>
        <button
          type="button"
          onClick={onArchive}
          disabled={busy}
          className="text-xs text-neutral-600 hover:underline"
        >
          Archive
        </button>
      </div>
    </div>
  )
}

function StudentEditor({
  mode,
  accountId,
  student,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  accountId: string
  student?: Student
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [firstName, setFirstName] = useState(student?.firstName ?? '')
  const [lastName, setLastName] = useState(student?.lastName ?? '')
  const [yearGroup, setYearGroup] = useState(student?.yearGroup ?? '')
  const [program, setProgram] = useState(student?.program ?? '')
  const [status, setStatus] = useState<Status>(student?.status ?? 'active')
  const [hoursContracted, setHoursContracted] = useState(
    student?.hoursContracted != null ? String(student.hoursContracted) : '',
  )
  const [hoursDelivered, setHoursDelivered] = useState(
    student?.hoursDelivered != null ? String(student.hoursDelivered) : '',
  )
  const [startDate, setStartDate] = useState(isoDate(student?.startDate))
  const [endDate, setEndDate] = useState(isoDate(student?.endDate))
  const [subjects, setSubjects] = useState(student?.subjects ?? '')
  const [notes, setNotes] = useState(student?.notes ?? '')
  const [bookingStudentId, setBookingStudentId] = useState(
    student?.bookingStudentId ?? '',
  )
  const [busy, setBusy] = useState(false)

  const create = trpc.businessAccount.students.create.useMutation()
  const update = trpc.businessAccount.students.update.useMutation()

  async function save() {
    if (!firstName.trim()) {
      toast.error('First name is required.')
      return
    }
    setBusy(true)
    try {
      const payload = {
        firstName: firstName.trim(),
        lastName: lastName.trim() || (mode === 'create' ? undefined : null),
        yearGroup: yearGroup.trim() || (mode === 'create' ? undefined : null),
        program: program.trim() || (mode === 'create' ? undefined : null),
        status,
        hoursContracted: hoursContracted.trim()
          ? Math.max(0, Math.trunc(Number(hoursContracted)))
          : mode === 'create'
            ? undefined
            : null,
        hoursDelivered: hoursDelivered.trim()
          ? Math.max(0, Math.trunc(Number(hoursDelivered)))
          : mode === 'create'
            ? undefined
            : null,
        startDate: startDate
          ? new Date(startDate)
          : mode === 'create'
            ? undefined
            : null,
        endDate: endDate ? new Date(endDate) : mode === 'create' ? undefined : null,
        subjects: subjects.trim() || (mode === 'create' ? undefined : null),
        notes: notes.trim() || (mode === 'create' ? undefined : null),
        bookingStudentId:
          bookingStudentId.trim() || (mode === 'create' ? undefined : null),
      }
      if (mode === 'create') {
        // Create path: nulls aren't valid; pass undefined instead.
        const createPayload = {
          accountId,
          firstName: payload.firstName,
          status,
          lastName: payload.lastName ?? undefined,
          yearGroup: payload.yearGroup ?? undefined,
          program: payload.program ?? undefined,
          hoursContracted: payload.hoursContracted ?? undefined,
          hoursDelivered: payload.hoursDelivered ?? undefined,
          startDate: payload.startDate ?? undefined,
          endDate: payload.endDate ?? undefined,
          subjects: payload.subjects ?? undefined,
          notes: payload.notes ?? undefined,
          bookingStudentId: payload.bookingStudentId ?? undefined,
        }
        await create.mutateAsync(createPayload)
        toast.success('Student added')
      } else if (student) {
        await update.mutateAsync({ id: student.id, ...payload })
        toast.success('Student updated')
      }
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          {mode === 'create' ? 'New student' : `Edit ${fullName(student!)}`}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="First name" required>
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
        </Field>
        <Field label="Last name">
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Field>
        <Field label="Year group">
          <Input
            value={yearGroup}
            onChange={(e) => setYearGroup(e.target.value)}
            placeholder="e.g. Y12, Sixth form"
          />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="withdrawn">Withdrawn</option>
          </Select>
        </Field>
        <Field label="Programme" wide>
          <Input
            value={program}
            onChange={(e) => setProgram(e.target.value)}
            placeholder="e.g. UCAT prep · 10 hours, Medical interview package"
          />
        </Field>
        <Field label="Hours contracted">
          <Input
            type="number"
            min={0}
            value={hoursContracted}
            onChange={(e) => setHoursContracted(e.target.value)}
          />
        </Field>
        <Field label="Hours delivered">
          <Input
            type="number"
            min={0}
            value={hoursDelivered}
            onChange={(e) => setHoursDelivered(e.target.value)}
          />
        </Field>
        <Field label="Start date">
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="End date">
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
        <Field label="Subjects" wide>
          <Input
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
            placeholder="e.g. Maths, Chemistry, Biology"
          />
        </Field>
        <Field label="Booking student id (for sync)" wide>
          <Input
            value={bookingStudentId}
            onChange={(e) => setBookingStudentId(e.target.value)}
            placeholder="from booking.studymind.co.uk"
          />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy || !firstName.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  wide,
  children,
}: {
  label: string
  required?: boolean
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
