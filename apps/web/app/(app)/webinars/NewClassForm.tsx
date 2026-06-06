'use client'

// Friendly "new class" form. Managers just type the subject and level/type —
// if it isn't in the catalogue yet it's created on the fly (no separate setup
// page to visit). When `cohortId` is fixed (used inside a cohort) the academic-
// year picker is hidden; on the master Classes page it shows the picker plus an
// inline "new academic year".

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function suggestDates(name: string): { startsOn: string; endsOn: string } | null {
  const m = /(\d{4})\s*\/\s*(\d{2,4})/.exec(name)
  if (!m) return null
  const start = Number(m[1])
  const endRaw = m[2]!.length === 2 ? Number(`${String(start).slice(0, 2)}${m[2]}`) : Number(m[2])
  return { startsOn: `${start}-09-01`, endsOn: `${endRaw}-07-31` }
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
  const cohorts = cohortsQ.data ?? []

  const createSubject = trpc.webinar.subject.create.useMutation()
  const createLevel = trpc.webinar.level.create.useMutation()
  const createCohortM = trpc.webinar.cohort.create.useMutation()
  const createClass = trpc.webinar.class.create.useMutation()

  const [pickedCohort, setPickedCohort] = useState('')
  const [subject, setSubject] = useState('')
  const [level, setLevel] = useState('')
  const [title, setTitle] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(5)
  const [time, setTime] = useState('17:00')
  const [zoomLink, setZoomLink] = useState('')
  const [busy, setBusy] = useState(false)

  // Inline new academic year (master page only).
  const [newYear, setNewYear] = useState(false)
  const [yearName, setYearName] = useState('')

  const effectiveCohort = cohortId || pickedCohort || cohorts[0]?.id || ''

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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!effectiveCohort) {
      toast.error('Pick or create an academic year first')
      return
    }
    if (!subject.trim() || !level.trim()) {
      toast.error('Enter a subject and a level/type')
      return
    }
    setBusy(true)
    try {
      const subjectHandle = await resolveHandle(subject, subjects, async (label) =>
        createSubject.mutateAsync({ label }),
      )
      const levelHandle = await resolveHandle(level, levels, async (label) =>
        createLevel.mutateAsync({ label }),
      )
      const [h, m] = time.split(':').map(Number)
      const sLabel = subjects.find((s) => s.handle === subjectHandle)?.label ?? subject.trim()
      const lLabel = levels.find((l) => l.handle === levelHandle)?.label ?? level.trim()
      const res = await createClass.mutateAsync({
        cohortId: effectiveCohort,
        subject: subjectHandle,
        level: levelHandle,
        title: title || `${lLabel} ${sLabel} weekly class`,
        dayOfWeek,
        startMinute: (h ?? 17) * 60 + (m ?? 0),
        ...(zoomLink ? { zoomLink } : {}),
      })
      toast.success('Class created')
      await Promise.all([
        utils.webinar.class.list.invalidate(),
        utils.webinar.subject.pickList.invalidate(),
        utils.webinar.level.pickList.invalidate(),
      ])
      if (onCreated) onCreated(res.id)
      else router.push(`/webinars/classes/${res.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the class')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardBody>
        <form className="grid gap-3 md:grid-cols-3" onSubmit={submit}>
          {!cohortId ? (
            <Field label="Academic year" htmlFor="ncf-cohort">
              {newYear ? (
                <div className="flex gap-2">
                  <Input placeholder="2027/2028" value={yearName} onChange={(e) => setYearName(e.target.value)} />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={createCohortM.isPending}
                    onClick={async () => {
                      const dates = suggestDates(yearName)
                      if (!dates) {
                        toast.error('Use a "2027/2028" style year so dates can be inferred')
                        return
                      }
                      try {
                        const c = await createCohortM.mutateAsync({ name: yearName, status: 'active', ...dates })
                        await utils.webinar.cohort.list.invalidate()
                        setPickedCohort(c.id)
                        setNewYear(false)
                        setYearName('')
                        toast.success('Academic year created')
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : 'Could not create the year')
                      }
                    }}
                  >
                    Add
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Select id="ncf-cohort" value={effectiveCohort} onChange={(e) => setPickedCohort(e.target.value)}>
                    {cohorts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.status === 'active' ? '(active)' : `(${c.status})`}
                      </option>
                    ))}
                  </Select>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setNewYear(true)}>
                    ＋ New
                  </Button>
                </div>
              )}
            </Field>
          ) : null}

          <Field label="Subject" htmlFor="ncf-subject" hint="Type a new one to add it.">
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

          <Field label="Level / type" htmlFor="ncf-level" hint="GCSE, A-Level, UCAT… type a new one to add it.">
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

          <Field label="Title (optional)" htmlFor="ncf-title" className="md:col-span-3">
            <Input
              id="ncf-title"
              placeholder="A-Level Biology weekly class"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Day" htmlFor="ncf-day">
            <Select id="ncf-day" value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start time" htmlFor="ncf-time">
            <Input id="ncf-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Zoom link (optional)" htmlFor="ncf-zoom">
            <Input
              id="ncf-zoom"
              type="url"
              placeholder="https://zoom.us/j/…"
              value={zoomLink}
              onChange={(e) => setZoomLink(e.target.value)}
            />
          </Field>
          <div className="md:col-span-3">
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create class'}
            </Button>
            <span className="ml-3 text-xs text-neutral-500">
              Import the weekly schedule (CSV/PDF) and set the Zoom link on the next screen. Need to
              rename or remove a subject/level?{' '}
              <a href="/webinars/subjects" className="text-primary-700 hover:underline">
                Manage the list
              </a>
              .
            </span>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
