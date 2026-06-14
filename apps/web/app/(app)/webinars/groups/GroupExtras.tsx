'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RichTextEditor } from '@/components/ui/rich-text-editor'
import { htmlToPlainText } from '@/lib/html-text'
import { trpc } from '@/lib/trpc/client'
import {
  buildPreviewVars,
  REMINDER_FIELDS,
  REMINDER_PRESETS,
  renderTokens,
} from '@/lib/webinar/reminder-templates'

import type { ClassDetailView, CohortDetail } from '../types'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Group-level settings that round out the class workspace: the reminder email
 *  (its own template), the academic-year term dates + holidays, and delete. */
export function GroupExtras({
  detail,
  cohort,
  canManage,
}: {
  detail: ClassDetailView
  cohort: CohortDetail
  canManage: boolean
}) {
  if (!canManage) return null
  return (
    <>
      <ReminderEmailCard detail={detail} />
      <TermDatesCard cohort={cohort} />
      <DangerCard classId={detail.id} name={`${detail.subjectLabel} ${detail.levelLabel}`} />
    </>
  )
}

function ReminderEmailCard({ detail }: { detail: ClassDetailView }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [subject, setSubject] = useState(detail.emailSubjectTemplate || REMINDER_PRESETS[0]!.subject)
  const [seed, setSeed] = useState(detail.emailBodyHtml || REMINDER_PRESETS[0]!.bodyHtml)
  const [bodyHtml, setBodyHtml] = useState(seed)
  const [resetKey, setResetKey] = useState(0)
  const [days, setDays] = useState<number[]>(detail.sendDaysOfWeek)
  const [hour, setHour] = useState(detail.sendHourLocal)

  const vars = buildPreviewVars(detail)
  const previewSubject = renderTokens(subject, vars)
  const previewBody = renderTokens(bodyHtml, vars)

  const update = trpc.webinar.class.update.useMutation({
    onSuccess: () => {
      toast.success('Reminder email saved')
      void utils.webinar.class.get.invalidate({ id: detail.id })
      router.refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const sendTest = trpc.webinar.class.sendTestReminder.useMutation({
    onSuccess: (r) => toast.success(`Test reminder + PDF sent to ${r.to}`),
    onError: (e) => toast.error(e.message),
  })

  function applyPreset(p: (typeof REMINDER_PRESETS)[number]) {
    setSubject(p.subject)
    setSeed(p.bodyHtml)
    setBodyHtml(p.bodyHtml)
    setResetKey((k) => k + 1)
  }

  function save() {
    const html = bodyHtml.trim()
    update.mutate({
      id: detail.id,
      emailSubjectTemplate: subject.trim() || null,
      emailBodyHtml: html || null,
      // Keep a plain-text version for text-only mail clients.
      emailBodyTemplate: html ? htmlToPlainText(html).trim() || null : null,
      sendDaysOfWeek: days,
      sendHourLocal: hour,
    })
  }

  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-neutral-900">Reminder email</h2>
        <p className="mt-1 text-xs text-neutral-500">
          This group&apos;s own weekly email — edit it like a document. Use{' '}
          <strong>+ Insert field</strong> to drop in the student&apos;s name, the date, the topic or
          the Zoom link; they fill in automatically each week. The preview shows this week&apos;s
          real values.
        </p>

        <div className="mt-3">
          <span className="text-xs font-medium text-neutral-500">Start from a template:</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {REMINDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.description}
                onClick={() => applyPreset(p)}
                className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 space-y-3">
          <Field label="Subject" htmlFor="ge-subj">
            <Input id="ge-subj" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-1">
            {REMINDER_FIELDS.map((f) => (
              <button
                key={f.token}
                type="button"
                onClick={() => setSubject((s) => `${s} ${f.token}`.trim())}
                className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-200"
              >
                + {f.label}
              </button>
            ))}
          </div>

          <Field label="Body" htmlFor="ge-body">
            <RichTextEditor
              initialHtml={seed}
              resetKey={resetKey}
              fields={REMINDER_FIELDS}
              onChange={setBodyHtml}
            />
          </Field>

          <div className="rounded-md border border-neutral-200 bg-neutral-50/60 p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Preview (this week&apos;s values)
            </div>
            <div className="mt-1.5 text-sm font-semibold text-neutral-900">{previewSubject}</div>
            <div
              className="prose-sm mt-1 max-w-none text-sm text-neutral-700 [&_a]:text-primary-700 [&_a]:underline [&_li]:my-0.5 [&_ul]:list-disc [&_ul]:pl-5"
              // Manager-authored template rendered with sample/real values — internal preview only.
              dangerouslySetInnerHTML={{ __html: previewBody }}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Send on" htmlFor="ge-days" hint="Which weekday(s) the reminder goes out.">
              <div id="ge-days" className="flex flex-wrap gap-1">
                {DAYS.map((d, i) => {
                  const on = days.includes(i)
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() =>
                        setDays((prev) =>
                          prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort(),
                        )
                      }
                      className={
                        'rounded-md px-2.5 py-1 text-xs ' +
                        (on
                          ? 'bg-primary-600 font-medium text-white'
                          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200')
                      }
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </Field>
            <Field label="From hour (local)" htmlFor="ge-hour">
              <Input
                id="ge-hour"
                type="number"
                min={0}
                max={23}
                value={hour}
                onChange={(e) => setHour(Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save reminder email'}
            </Button>
            <Button
              variant="secondary"
              disabled={sendTest.isPending}
              onClick={() => sendTest.mutate({ id: detail.id })}
            >
              {sendTest.isPending ? 'Sending…' : 'Send test to me'}
            </Button>
            <a
              href={`/webinars/groups/${detail.id}/schedule.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary-700 hover:underline"
            >
              Preview attached PDF →
            </a>
          </div>
          <p className="text-xs text-neutral-400">
            “Send test to me” emails you the real reminder with the schedule PDF attached, so you see
            exactly what students get. Save first to test your latest edits.
          </p>
        </div>
      </CardBody>
    </Card>
  )
}

function TermDatesCard({ cohort }: { cohort: CohortDetail }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [startsOn, setStartsOn] = useState(cohort.startsOn)
  const [endsOn, setEndsOn] = useState(cohort.endsOn)
  const [hName, setHName] = useState('')
  const [hStart, setHStart] = useState('')
  const [hEnd, setHEnd] = useState('')

  const refresh = () => {
    void utils.webinar.cohort.get.invalidate({ id: cohort.id })
    router.refresh()
  }
  const update = trpc.webinar.cohort.update.useMutation({
    onSuccess: () => {
      toast.success('Term dates saved')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const addHoliday = trpc.webinar.cohort.addHoliday.useMutation({
    onSuccess: () => {
      toast.success('Holiday added')
      setHName('')
      setHStart('')
      setHEnd('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const removeHoliday = trpc.webinar.cohort.removeHoliday.useMutation({
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  })

  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-neutral-900">Term dates &amp; holidays</h2>
        <p className="mt-1 text-xs text-neutral-500">
          The academic year (<strong>{cohort.name}</strong>) this group runs in. No reminders go out
          on holiday dates. Shared with any other groups in the same year.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Field label="Term starts" htmlFor="ge-start">
            <Input id="ge-start" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Term ends" htmlFor="ge-end">
            <Input id="ge-end" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: cohort.id, startsOn, endsOn })}
            >
              Save dates
            </Button>
          </div>
        </div>

        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Holidays</h3>
          {cohort.holidays.length === 0 ? (
            <p className="mt-1 text-sm text-neutral-500">None yet.</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {cohort.holidays.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between gap-2 rounded bg-neutral-50 px-3 py-1.5 text-sm"
                >
                  <span>
                    <span className="font-medium text-neutral-800">{h.name}</span>{' '}
                    <span className="text-neutral-500">
                      {h.startsOn}
                      {h.endsOn !== h.startsOn ? ` → ${h.endsOn}` : ''}
                    </span>
                  </span>
                  <Button variant="ghost" size="xs" onClick={() => removeHoliday.mutate({ id: h.id })}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
            <Input placeholder="Christmas break" value={hName} onChange={(e) => setHName(e.target.value)} />
            <Input type="date" value={hStart} onChange={(e) => setHStart(e.target.value)} className="w-40" />
            <Input type="date" value={hEnd} onChange={(e) => setHEnd(e.target.value)} className="w-40" />
            <Button
              size="sm"
              variant="secondary"
              disabled={addHoliday.isPending || !hName || !hStart}
              onClick={() =>
                addHoliday.mutate({
                  cohortId: cohort.id,
                  name: hName,
                  startsOn: hStart,
                  endsOn: hEnd || hStart,
                })
              }
            >
              Add
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

function DangerCard({ classId, name }: { classId: string; name: string }) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const del = trpc.webinar.class.delete.useMutation({
    onSuccess: async () => {
      toast.success('Group deleted')
      await utils.webinar.class.list.invalidate()
      router.push('/webinars/groups')
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Card className="border-red-200">
      <CardBody>
        <h2 className="text-sm font-semibold text-red-800">Delete this group</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Permanently removes <strong>{name}</strong> — its weekly classes, students and Zoom
          meeting. This cannot be undone.
        </p>
        <Button
          variant="destructive"
          size="sm"
          className="mt-3"
          disabled={del.isPending}
          onClick={() => {
            if (confirm(`Delete "${name}"? This cannot be undone.`)) del.mutate({ id: classId })
          }}
        >
          {del.isPending ? 'Deleting…' : 'Delete group'}
        </Button>
      </CardBody>
    </Card>
  )
}
