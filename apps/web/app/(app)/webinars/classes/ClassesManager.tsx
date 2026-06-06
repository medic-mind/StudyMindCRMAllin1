'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

import type { ClassRow, CohortRow, CataloguePick } from '../types'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function fmtMinute(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Suggest Sep 1 – Jul 31 for a "2026/2027"-style year label. */
function suggestDates(name: string): { startsOn: string; endsOn: string } | null {
  const m = /(\d{4})\s*\/\s*(\d{2,4})/.exec(name)
  if (!m) return null
  const start = Number(m[1])
  const endRaw = m[2]!.length === 2 ? Number(`${String(start).slice(0, 2)}${m[2]}`) : Number(m[2])
  return { startsOn: `${start}-09-01`, endsOn: `${endRaw}-07-31` }
}

export function ClassesManager({
  initialClasses,
  initialCohorts,
  initialSubjects,
  initialLevels,
  canManage,
}: {
  initialClasses: ClassRow[]
  initialCohorts: CohortRow[]
  initialSubjects: CataloguePick[]
  initialLevels: CataloguePick[]
  canManage: boolean
}) {
  const utils = trpc.useUtils()
  const list = trpc.webinar.class.list.useQuery({}, { initialData: initialClasses })
  const cohortsQ = trpc.webinar.cohort.list.useQuery(undefined, { initialData: initialCohorts })
  const subjectsQ = trpc.webinar.subject.pickList.useQuery(undefined, { initialData: initialSubjects })
  const levelsQ = trpc.webinar.level.pickList.useQuery(undefined, { initialData: initialLevels })

  const [showForm, setShowForm] = useState(false)
  const create = trpc.webinar.class.create.useMutation({
    onSuccess: ({ id }) => {
      toast.success('Class created')
      setShowForm(false)
      void utils.webinar.class.list.invalidate()
      window.location.href = `/webinars/classes/${id}`
    },
    onError: (e) => toast.error(e.message),
  })

  const cohorts = cohortsQ.data ?? []
  const subjects = subjectsQ.data ?? []
  const levels = levelsQ.data ?? []
  const classes = list.data ?? []

  const [cohortId, setCohortId] = useState('')
  const [subject, setSubject] = useState('')
  const [level, setLevel] = useState('')
  const [title, setTitle] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(5)
  const [time, setTime] = useState('17:00')
  const [zoomLink, setZoomLink] = useState('')

  // Inline "new academic year".
  const [newYear, setNewYear] = useState(false)
  const [yearName, setYearName] = useState('')
  const createCohort = trpc.webinar.cohort.create.useMutation({
    onSuccess: async ({ id }) => {
      toast.success('Academic year created')
      await utils.webinar.cohort.list.invalidate()
      setCohortId(id)
      setNewYear(false)
      setYearName('')
    },
    onError: (e) => toast.error(e.message),
  })

  const effectiveCohort = cohortId || cohorts[0]?.id || ''
  const effectiveSubject = subject || subjects[0]?.handle || ''
  const effectiveLevel = level || levels[0]?.handle || ''

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!effectiveCohort || !effectiveSubject || !effectiveLevel) {
      toast.error('Pick an academic year, subject and level first')
      return
    }
    const [h, m] = time.split(':').map(Number)
    const sLabel = subjects.find((s) => s.handle === effectiveSubject)?.label ?? effectiveSubject
    const lLabel = levels.find((l) => l.handle === effectiveLevel)?.label ?? effectiveLevel
    create.mutate({
      cohortId: effectiveCohort,
      subject: effectiveSubject,
      level: effectiveLevel,
      title: title || `${lLabel} ${sLabel} weekly class`,
      dayOfWeek,
      startMinute: (h ?? 17) * 60 + (m ?? 0),
      ...(zoomLink ? { zoomLink } : {}),
    })
  }

  return (
    <div className="space-y-5">
      {canManage ? (
        <div className="flex items-center gap-3">
          <Button onClick={() => setShowForm((s) => !s)}>{showForm ? 'Cancel' : 'New class'}</Button>
          <Link href="/webinars/subjects" className="text-sm text-primary-700 hover:underline">
            Manage subjects &amp; levels →
          </Link>
        </div>
      ) : null}

      {showForm ? (
        <Card>
          <CardBody>
            <form className="grid gap-3 md:grid-cols-3" onSubmit={submit}>
              <Field label="Academic year" htmlFor="cohort">
                {newYear ? (
                  <div className="flex gap-2">
                    <Input
                      placeholder="2027/2028"
                      value={yearName}
                      onChange={(e) => setYearName(e.target.value)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={createCohort.isPending}
                      onClick={() => {
                        const dates = suggestDates(yearName)
                        if (!dates) {
                          toast.error('Use a "2027/2028" style year so dates can be inferred')
                          return
                        }
                        createCohort.mutate({ name: yearName, status: 'active', ...dates })
                      }}
                    >
                      Add
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Select
                      id="cohort"
                      value={effectiveCohort}
                      onChange={(e) => setCohortId(e.target.value)}
                    >
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
              <Field label="Subject" htmlFor="subject">
                <Select id="subject" value={effectiveSubject} onChange={(e) => setSubject(e.target.value)}>
                  {subjects.map((s) => (
                    <option key={s.handle} value={s.handle}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Level / type" htmlFor="level">
                <Select id="level" value={effectiveLevel} onChange={(e) => setLevel(e.target.value)}>
                  {levels.map((l) => (
                    <option key={l.handle} value={l.handle}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Title (optional)" htmlFor="title" className="md:col-span-3">
                <Input
                  id="title"
                  placeholder="A-Level Biology weekly class"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Day" htmlFor="day">
                <Select id="day" value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Start time" htmlFor="time">
                <Input id="time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
              <Field label="Zoom link (optional)" htmlFor="zoom">
                <Input
                  id="zoom"
                  type="url"
                  placeholder="https://zoom.us/j/…"
                  value={zoomLink}
                  onChange={(e) => setZoomLink(e.target.value)}
                />
              </Field>
              <div className="md:col-span-3">
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? 'Creating…' : 'Create class'}
                </Button>
                <span className="ml-3 text-xs text-neutral-500">
                  You can import the weekly schedule (CSV/PDF) on the next screen.
                </span>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {classes.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">No classes yet.</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3">
          {classes.map((c) => (
            <Link key={c.id} href={`/webinars/classes/${c.id}`} className="block">
              <Card className="transition-shadow hover:shadow-md">
                <CardBody>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900">
                          {c.subjectLabel} {c.levelLabel}
                        </span>
                        {!c.active ? <Badge tone="neutral">inactive</Badge> : null}
                        {c.zoomRotationDue ? <Badge tone="danger">rotate Zoom link</Badge> : null}
                        {!c.zoomLink ? <Badge tone="warn">no Zoom link</Badge> : null}
                        {c.hasUploadedPdf ? <Badge tone="info">PDF syllabus</Badge> : null}
                      </div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {c.cohortName} · {c.dayLabel}s at {fmtMinute(c.startMinute)} ·{' '}
                        {c.enrollmentCount} enrolled ·{' '}
                        {c.weekState === 'in_week'
                          ? `Week ${c.currentWeekNumber} of ${c.totalWeeks}`
                          : c.weekState === 'not_started'
                            ? 'not started'
                            : c.weekState === 'between'
                              ? `on a break (next Week ${c.currentWeekNumber})`
                              : 'term ended'}
                      </div>
                    </div>
                    <span className="text-sm text-primary-700">Manage →</span>
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
