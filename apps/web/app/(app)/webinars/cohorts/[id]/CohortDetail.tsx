'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

import { NewClassForm } from '../../NewClassForm'
import { SendDaysPicker } from '../../SendDaysPicker'
import type { CohortDetail as CohortDetailView } from '../../types'

const PLACEHOLDERS = [
  'studentName',
  'className',
  'subject',
  'level',
  'cohortName',
  'weekday',
  'dateLabel',
  'timeLabel',
  'zoomLink',
  'weekNumber',
  'weekTopic',
  'fromName',
]

export function CohortDetail({
  cohort,
  canManage,
}: {
  cohort: CohortDetailView
  canManage: boolean
}) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)

  const setStatus = trpc.webinar.cohort.setStatus.useMutation({
    onSuccess: () => {
      toast.success('Status updated')
      router.refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  const refresh = () => router.refresh()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-neutral-600">Status</span>
        {canManage ? (
          <Select
            value={cohort.status}
            onChange={(e) =>
              setStatus.mutate({ id: cohort.id, status: e.target.value as 'planning' | 'active' | 'archived' })
            }
          >
            <option value="planning">Planning</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
        ) : (
          <Badge tone="info">{cohort.status}</Badge>
        )}
      </div>

      {/* Classes */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">
            Classes ({cohort.classes.length})
          </h2>
          {canManage ? (
            <Button size="sm" onClick={() => setShowForm((s) => !s)}>
              {showForm ? 'Cancel' : 'New class'}
            </Button>
          ) : null}
        </div>

        {showForm ? (
          <div className="mb-3">
            <NewClassForm
              cohortId={cohort.id}
              onCreated={(id) => router.push(`/webinars/classes/${id}`)}
            />
          </div>
        ) : null}

        {cohort.classes.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-neutral-500">
                No classes in this cohort yet{canManage ? ' — add one above.' : '.'}
              </p>
            </CardBody>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {cohort.classes.map((c) => (
              <Link key={c.id} href={`/webinars/classes/${c.id}`} className="block">
                <Card className="transition-shadow hover:shadow-md">
                  <CardBody>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900">
                          {c.subjectLabel} {c.levelLabel}
                        </span>
                        {!c.active ? <Badge tone="neutral">inactive</Badge> : null}
                      </div>
                      <span className="text-sm text-primary-700">Manage →</span>
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-500">
                      {c.enrollmentCount} on the mailing list
                    </div>
                  </CardBody>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Per-cohort emails */}
      <EmailSettings cohort={cohort} canManage={canManage} />

      {/* Holidays */}
      <Holidays cohortId={cohort.id} holidays={cohort.holidays} canManage={canManage} onChange={refresh} />
    </div>
  )
}

function EmailSettings({
  cohort,
  canManage,
}: {
  cohort: CohortDetailView
  canManage: boolean
}) {
  const [fromName, setFromName] = useState(cohort.fromName)
  const [subjectTpl, setSubjectTpl] = useState(cohort.emailSubjectTemplate)
  const [bodyTpl, setBodyTpl] = useState(cohort.emailBodyTemplate)
  const [html, setHtml] = useState(cohort.emailBodyHtml)
  const [sendDays, setSendDays] = useState<number[]>(cohort.sendDaysOfWeek)
  const [sendHour, setSendHour] = useState(cohort.sendHourLocal)
  const [showHtml, setShowHtml] = useState(Boolean(cohort.emailBodyHtml))

  const save = trpc.webinar.cohort.update.useMutation({
    onSuccess: () => toast.success('Email settings saved for this cohort'),
    onError: (e) => toast.error(e.message),
  })

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">Weekly email for this cohort</h2>
          <p className="mt-1 text-xs text-neutral-500">
            This template is used for every class in <strong>{cohort.name}</strong>. Reminders go out
            on the chosen days from info@studymind.co.uk with the Zoom link + PDF schedule attached.
            Placeholders:{' '}
            {PLACEHOLDERS.map((p) => (
              <code key={p} className="mr-1 rounded bg-neutral-100 px-1 py-0.5 text-[11px]">
                {'{{' + p + '}}'}
              </code>
            ))}
          </p>
        </div>

        {canManage ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate({
                id: cohort.id,
                fromName,
                emailSubjectTemplate: subjectTpl,
                emailBodyTemplate: bodyTpl,
                emailBodyHtml: showHtml ? html : '',
                sendDaysOfWeek: sendDays,
                sendHourLocal: sendHour,
              })
            }}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="From name" htmlFor="from">
                <Input
                  id="from"
                  placeholder="The StudyMind team"
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                />
              </Field>
              <Field label="Send hour (local, 0-23)" htmlFor="hour">
                <Input
                  id="hour"
                  type="number"
                  min={0}
                  max={23}
                  value={sendHour}
                  onChange={(e) => setSendHour(Number(e.target.value))}
                />
              </Field>
            </div>
            <Field label="Send days" htmlFor="days">
              <SendDaysPicker value={sendDays} onChange={setSendDays} />
            </Field>
            <Field label="Subject line" htmlFor="subj">
              <Input
                id="subj"
                placeholder="{{className}} — this week's class ({{dateLabel}})"
                value={subjectTpl}
                onChange={(e) => setSubjectTpl(e.target.value)}
              />
            </Field>
            <Field label="Body (plain text)" htmlFor="body">
              <Textarea
                id="body"
                rows={10}
                placeholder="Hi {{studentName}}, here are this week's details…"
                value={bodyTpl}
                onChange={(e) => setBodyTpl(e.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" checked={showHtml} onChange={(e) => setShowHtml(e.target.checked)} />
              Add a rich HTML version (for branded formatting)
            </label>
            {showHtml ? (
              <Field label="Body (HTML)" htmlFor="html" hint="Sent alongside the plain-text body.">
                <Textarea
                  id="html"
                  rows={10}
                  placeholder="<p>Hi {{studentName}}, …</p>"
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                />
              </Field>
            ) : null}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save email settings'}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-neutral-500">Manager access required to edit.</p>
        )}
      </CardBody>
    </Card>
  )
}

function Holidays({
  cohortId,
  holidays,
  canManage,
  onChange,
}: {
  cohortId: string
  holidays: CohortDetailView['holidays']
  canManage: boolean
  onChange: () => void
}) {
  const add = trpc.webinar.cohort.addHoliday.useMutation({
    onSuccess: () => {
      toast.success('Holiday added')
      setName('')
      setStartsOn('')
      setEndsOn('')
      onChange()
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = trpc.webinar.cohort.removeHoliday.useMutation({
    onSuccess: onChange,
    onError: (e) => toast.error(e.message),
  })

  const [name, setName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')

  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-neutral-900">Holidays</h2>
        <p className="mt-1 text-xs text-neutral-500">No class emails are sent during these breaks.</p>
        {holidays.length > 0 ? (
          <ul className="mt-3 space-y-1">
            {holidays.map((h) => (
              <li
                key={h.id}
                className="flex items-center justify-between rounded bg-neutral-50 px-3 py-1.5 text-sm"
              >
                <span>
                  <span className="font-medium text-neutral-800">{h.name}</span>{' '}
                  <span className="text-neutral-500">
                    {h.startsOn} → {h.endsOn}
                  </span>
                </span>
                {canManage ? (
                  <Button variant="ghost" size="xs" onClick={() => remove.mutate({ id: h.id })}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-neutral-500">No holidays set.</p>
        )}
        {canManage ? (
          <form
            className="mt-3 grid gap-2 md:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault()
              add.mutate({ cohortId, name, startsOn, endsOn })
            }}
          >
            <Input placeholder="Christmas break" value={name} onChange={(e) => setName(e.target.value)} required />
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} required />
            <Button type="submit" variant="secondary" size="sm" disabled={add.isPending}>
              Add holiday
            </Button>
          </form>
        ) : null}
      </CardBody>
    </Card>
  )
}
