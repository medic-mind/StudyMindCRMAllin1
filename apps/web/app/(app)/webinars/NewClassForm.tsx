'use client'

// Dead-simple "new group" form (CLAUDE.md §47). A group is one subject + level
// (e.g. "A-Level Biology"). The whole flow is: name the subject, pick the year
// group / level, say when it meets, and add students — that's it.
//
// Deliberately NOT asked here (they were the "faff" that made this confusing):
//   • The academic year (2025/2026) is resolved automatically — the current
//     active year — with a tucked-away "Change" for the rare case. No more
//     TWO "year" fields stacked on top of each other.
//   • The title is auto-generated ("A-Level Biology weekly class"), editable later.
//   • The Zoom link + weekly schedule are set on the group's own page afterwards.
// Students can be added right here (search + add several) instead of on a
// separate screen.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

interface CohortRow {
  id: string
  name: string
  startsOn: string
  endsOn: string
  status: 'planning' | 'active' | 'archived'
}

interface StagedStudent {
  id: string
  name: string
  email: string | null
}

/** The academic year a new group should default to: the active year that
 *  contains today, else any active year, else the one covering today, else the
 *  most recent. `null` when none exist yet (we create one on submit). */
function pickDefaultCohort(cohorts: CohortRow[], todayIso: string): CohortRow | null {
  if (cohorts.length === 0) return null
  const contains = (c: CohortRow) => c.startsOn <= todayIso && todayIso <= c.endsOn
  return (
    cohorts.find((c) => c.status === 'active' && contains(c)) ??
    cohorts.find((c) => c.status === 'active') ??
    cohorts.find(contains) ??
    cohorts[0]! // list is ordered by startsOn desc → most recent
  )
}

/** Current UK academic year (Sept–July) for a first-ever auto-created year. */
function currentAcademicYear(now: Date): { name: string; startsOn: string; endsOn: string } {
  const y = now.getFullYear()
  // From August onward we're into the next academic year's run-up.
  const startYear = now.getMonth() >= 7 ? y : y - 1
  return {
    name: `${startYear}/${startYear + 1}`,
    startsOn: `${startYear}-09-01`,
    endsOn: `${startYear + 1}-07-31`,
  }
}

export function NewClassForm({
  cohortId,
  onCreated,
}: {
  cohortId?: string
  onCreated?: (id: string) => void
}) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const cohortsQ = trpc.webinar.cohort.list.useQuery(undefined, { enabled: !cohortId })
  const subjectsQ = trpc.webinar.subject.pickList.useQuery()
  const levelsQ = trpc.webinar.level.pickList.useQuery()

  const subjects = subjectsQ.data ?? []
  const levels = levelsQ.data ?? []
  const cohorts = (cohortsQ.data ?? []) as CohortRow[]

  const createSubject = trpc.webinar.subject.create.useMutation()
  const createLevel = trpc.webinar.level.create.useMutation()
  const createCohortM = trpc.webinar.cohort.create.useMutation()
  const createClass = trpc.webinar.class.create.useMutation()
  const createEnrollment = trpc.webinar.enrollment.create.useMutation()

  const [subject, setSubject] = useState('')
  const [level, setLevel] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(5)
  const [time, setTime] = useState('17:00')
  const [students, setStudents] = useState<StagedStudent[]>([])
  const [busy, setBusy] = useState(false)

  // Academic year: auto-resolved, editable behind "Change".
  const todayIso = new Date().toISOString().slice(0, 10)
  const autoCohort = useMemo(() => pickDefaultCohort(cohorts, todayIso), [cohorts, todayIso])
  const [pickedCohortId, setPickedCohortId] = useState<string | null>(null)
  const [changingYear, setChangingYear] = useState(false)
  const [newYearName, setNewYearName] = useState('')
  const effectiveCohortId = cohortId ?? pickedCohortId ?? autoCohort?.id ?? null
  const effectiveCohortName =
    cohorts.find((c) => c.id === effectiveCohortId)?.name ?? (cohorts.length === 0 ? 'new year' : '…')

  /** Resolve a typed label to a catalogue handle, creating the option if new. */
  async function resolveHandle(
    typed: string,
    options: Array<{ handle: string; label: string }>,
    create: (label: string) => Promise<{ handle: string }>,
  ): Promise<string> {
    const t = typed.trim()
    const match = options.find(
      (o) => o.label.toLowerCase() === t.toLowerCase() || o.handle === t.toLowerCase(),
    )
    if (match) return match.handle
    const created = await create(t)
    return created.handle
  }

  /** Resolve (or create for a brand-new install) the academic year to use. */
  async function resolveCohortId(): Promise<string> {
    if (cohortId) return cohortId
    if (effectiveCohortId) return effectiveCohortId
    // No academic year exists at all — create the current one silently.
    const y = currentAcademicYear(new Date())
    const c = await createCohortM.mutateAsync({ name: y.name, status: 'active', startsOn: y.startsOn, endsOn: y.endsOn })
    await utils.webinar.cohort.list.invalidate()
    return c.id
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!subject.trim() || !level.trim()) {
      toast.error('Enter a subject and a year group / level')
      return
    }
    setBusy(true)
    try {
      const resolvedCohortId = await resolveCohortId()
      const subjectHandle = await resolveHandle(subject, subjects, (label) =>
        createSubject.mutateAsync({ label }),
      )
      const levelHandle = await resolveHandle(level, levels, (label) =>
        createLevel.mutateAsync({ label }),
      )
      const [h, m] = time.split(':').map(Number)
      const sLabel = subjects.find((s) => s.handle === subjectHandle)?.label ?? subject.trim()
      const lLabel = levels.find((l) => l.handle === levelHandle)?.label ?? level.trim()
      const res = await createClass.mutateAsync({
        cohortId: resolvedCohortId,
        subject: subjectHandle,
        level: levelHandle,
        title: `${lLabel} ${sLabel} weekly class`,
        dayOfWeek,
        startMinute: (h ?? 17) * 60 + (m ?? 0),
      })

      // Add the staged students to the new group's list (best effort).
      let added = 0
      for (const s of students) {
        try {
          await createEnrollment.mutateAsync({ classId: res.id, contactId: s.id, status: 'active' })
          added += 1
        } catch {
          // Skip a duplicate/failed one; the rest still enrol.
        }
      }

      await Promise.all([
        utils.webinar.class.list.invalidate(),
        utils.webinar.subject.pickList.invalidate(),
        utils.webinar.level.pickList.invalidate(),
      ])
      toast.success(
        added > 0
          ? `Group created with ${added} student${added === 1 ? '' : 's'}`
          : 'Group created',
      )
      if (onCreated) onCreated(res.id)
      else router.push(`/webinars/groups/${res.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the group')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardBody>
        <form className="space-y-4" onSubmit={submit}>
          {/* 1 — what the group is */}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Subject" htmlFor="ncf-subject" hint="e.g. Biology. Type a new one to add it.">
              <Input
                id="ncf-subject"
                list="ncf-subject-options"
                placeholder="Biology"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
              <datalist id="ncf-subject-options">
                {subjects.map((s) => (
                  <option key={s.handle} value={s.label} />
                ))}
              </datalist>
            </Field>

            <Field
              label="Year group / level"
              htmlFor="ncf-level"
              hint="e.g. GCSE, A-Level, Year 12, UCAT. Type a new one to add it."
            >
              <Input
                id="ncf-level"
                list="ncf-level-options"
                placeholder="A-Level"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                required
              />
              <datalist id="ncf-level-options">
                {levels.map((l) => (
                  <option key={l.handle} value={l.label} />
                ))}
              </datalist>
            </Field>
          </div>

          {/* 2 — when it meets */}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Meets on" htmlFor="ncf-day">
              <Select id="ncf-day" value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}s
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Start time" htmlFor="ncf-time">
              <Input id="ncf-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>

          {/* 3 — students */}
          <Field label="Add students" htmlFor="ncf-student" hint="Optional — you can also add them later.">
            <StudentPicker
              staged={students}
              onAdd={(s) => setStudents((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s]))}
              onRemove={(id) => setStudents((prev) => prev.filter((p) => p.id !== id))}
            />
          </Field>

          {/* academic year — auto, tucked away */}
          {!cohortId ? (
            <div className="text-xs text-neutral-500">
              {changingYear ? (
                <ChangeYear
                  cohorts={cohorts}
                  value={effectiveCohortId}
                  onPick={(id) => {
                    setPickedCohortId(id)
                    setChangingYear(false)
                  }}
                  newYearName={newYearName}
                  setNewYearName={setNewYearName}
                  creating={createCohortM.isPending}
                  onCreate={async () => {
                    const m = /(\d{4})\s*\/\s*(\d{2,4})/.exec(newYearName)
                    if (!m) {
                      toast.error('Use a "2027/2028" style year')
                      return
                    }
                    const start = Number(m[1])
                    const endRaw =
                      m[2]!.length === 2 ? Number(`${String(start).slice(0, 2)}${m[2]}`) : Number(m[2])
                    try {
                      const c = await createCohortM.mutateAsync({
                        name: newYearName,
                        status: 'active',
                        startsOn: `${start}-09-01`,
                        endsOn: `${endRaw}-07-31`,
                      })
                      await utils.webinar.cohort.list.invalidate()
                      setPickedCohortId(c.id)
                      setNewYearName('')
                      setChangingYear(false)
                      toast.success('Academic year created')
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Could not create the year')
                    }
                  }}
                />
              ) : (
                <>
                  Academic year: <span className="font-medium text-neutral-700">{effectiveCohortName}</span>{' '}
                  <button
                    type="button"
                    className="text-primary-700 hover:underline"
                    onClick={() => setChangingYear(true)}
                  >
                    Change
                  </button>
                </>
              )}
            </div>
          ) : null}

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create group'}
            </Button>
            <span className="text-xs text-neutral-500">
              Set the Zoom link and weekly schedule on the next screen.
            </span>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/** Contact typeahead that stages students to add to the new group. */
function StudentPicker({
  staged,
  onAdd,
  onRemove,
}: {
  staged: StagedStudent[]
  onAdd: (s: StagedStudent) => void
  onRemove: (id: string) => void
}) {
  const [term, setTerm] = useState('')
  const search = trpc.webinar.enrollment.contactSearch.useQuery(
    { term },
    { enabled: term.trim().length >= 2 },
  )
  const results = (search.data ?? []).filter((r) => !staged.some((s) => s.id === r.id))

  return (
    <div>
      {staged.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {staged.map((s) => (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2.5 py-0.5 text-xs text-primary-800"
            >
              {s.name}
              <button
                type="button"
                aria-label={`Remove ${s.name}`}
                className="text-primary-500 hover:text-primary-800"
                onClick={() => onRemove(s.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Input
        id="ncf-student"
        placeholder="Search a contact by name or email…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      {term.trim().length >= 2 && results.length > 0 ? (
        <div className="mt-1 divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
              onClick={() => {
                onAdd({ id: c.id, name: c.name, email: c.email })
                setTerm('')
              }}
            >
              <span>
                <span className="font-medium text-neutral-800">{c.name}</span>{' '}
                <span className="text-neutral-500">{c.email}</span>
              </span>
              <span className="text-xs text-primary-700">Add →</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The tucked-away academic-year override (pick an existing year or add one). */
function ChangeYear({
  cohorts,
  value,
  onPick,
  newYearName,
  setNewYearName,
  creating,
  onCreate,
}: {
  cohorts: CohortRow[]
  value: string | null
  onPick: (id: string) => void
  newYearName: string
  setNewYearName: (v: string) => void
  creating: boolean
  onCreate: () => void
}) {
  const [adding, setAdding] = useState(cohorts.length === 0)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span>Academic year:</span>
      {adding ? (
        <>
          <Input
            placeholder="2027/2028"
            value={newYearName}
            onChange={(e) => setNewYearName(e.target.value)}
            className="h-8 w-28"
          />
          <Button type="button" size="xs" variant="secondary" disabled={creating} onClick={onCreate}>
            Add
          </Button>
        </>
      ) : (
        <>
          <Select
            value={value ?? ''}
            onChange={(e) => onPick(e.target.value)}
            className="h-8 w-auto"
          >
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.status === 'active' ? '(active)' : `(${c.status})`}
              </option>
            ))}
          </Select>
          <button type="button" className="text-primary-700 hover:underline" onClick={() => setAdding(true)}>
            + New year
          </button>
        </>
      )}
    </div>
  )
}
