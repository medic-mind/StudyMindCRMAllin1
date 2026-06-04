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

import type { ClassRow } from '../types'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const SUBJECTS = ['biology', 'chemistry', 'physics', 'maths']

interface CohortOpt {
  id: string
  name: string
  status: string
}

function fmtMinute(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function ClassesManager({
  initialClasses,
  cohorts,
  canManage,
}: {
  initialClasses: ClassRow[]
  cohorts: CohortOpt[]
  canManage: boolean
}) {
  const utils = trpc.useUtils()
  const list = trpc.webinar.class.list.useQuery({}, { initialData: initialClasses })
  const [showForm, setShowForm] = useState(false)

  const create = trpc.webinar.class.create.useMutation({
    onSuccess: () => {
      toast.success('Class created')
      setShowForm(false)
      void utils.webinar.class.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const [cohortId, setCohortId] = useState(cohorts[0]?.id ?? '')
  const [subject, setSubject] = useState('biology')
  const [level, setLevel] = useState<'gcse' | 'a_level'>('a_level')
  const [title, setTitle] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [time, setTime] = useState('18:00')
  const [zoomLink, setZoomLink] = useState('')

  const classes = list.data ?? []

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const [h, m] = time.split(':').map(Number)
    create.mutate({
      cohortId,
      subject,
      level,
      title: title || `${subject} ${level === 'a_level' ? 'A-Level' : 'GCSE'} weekly class`,
      dayOfWeek,
      startMinute: (h ?? 18) * 60 + (m ?? 0),
      ...(zoomLink ? { zoomLink } : {}),
    })
  }

  return (
    <div className="space-y-5">
      {canManage ? (
        <div>
          {cohorts.length === 0 ? (
            <Card className="border-amber-200 bg-amber-50">
              <CardBody>
                <p className="text-sm text-amber-800">
                  Create a cohort first under{' '}
                  <Link href="/webinars/cohorts" className="font-medium underline">
                    Cohorts &amp; holidays
                  </Link>
                  .
                </p>
              </CardBody>
            </Card>
          ) : (
            <Button onClick={() => setShowForm((s) => !s)}>
              {showForm ? 'Cancel' : 'New class'}
            </Button>
          )}
        </div>
      ) : null}

      {showForm && cohorts.length > 0 ? (
        <Card>
          <CardBody>
            <form className="grid gap-3 md:grid-cols-3" onSubmit={submit}>
              <Field label="Cohort" htmlFor="cohort">
                <Select id="cohort" value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
                  {cohorts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.status === 'active' ? '(active)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Subject" htmlFor="subject">
                <Select id="subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
                  {SUBJECTS.map((s) => (
                    <option key={s} value={s}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Level" htmlFor="level">
                <Select
                  id="level"
                  value={level}
                  onChange={(e) => setLevel(e.target.value as 'gcse' | 'a_level')}
                >
                  <option value="gcse">GCSE</option>
                  <option value="a_level">A-Level</option>
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
                <Select
                  id="day"
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                >
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
                        {c.enrollmentCount} enrolled
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
