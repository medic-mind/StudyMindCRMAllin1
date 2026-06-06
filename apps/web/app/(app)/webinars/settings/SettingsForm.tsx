'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

import { SendDaysPicker } from '../SendDaysPicker'
import type { WebinarSettingsView as Settings } from '../types'

const PLACEHOLDERS = [
  'studentName',
  'className',
  'subject',
  'level',
  'dateLabel',
  'timeLabel',
  'zoomLink',
  'weekNumber',
  'weekTopic',
  'fromName',
]

const DEFAULT_SUBJECT = "{{className}} — this week's class ({{dateLabel}})"
const DEFAULT_BODY = `Hi {{studentName}},

Here are the details for this week's {{className}} session:

  • When: {{dateLabel}} at {{timeLabel}}
  • Week {{weekNumber}}: {{weekTopic}}
  • Join here: {{zoomLink}}

The full term schedule is attached as a PDF. Save the join link — it is the
same each week unless we tell you otherwise.

See you there,
{{fromName}}`

export function SettingsForm({ initial, canManage }: { initial: Settings; canManage: boolean }) {
  const [fromName, setFromName] = useState(initial.fromName)
  const [subjectTpl, setSubjectTpl] = useState(initial.emailSubjectTemplate || DEFAULT_SUBJECT)
  const [bodyTpl, setBodyTpl] = useState(initial.emailBodyTemplate || DEFAULT_BODY)
  const [sendDays, setSendDays] = useState<number[]>(initial.defaultSendDaysOfWeek)
  const [sendHour, setSendHour] = useState(initial.defaultSendHourLocal)
  const [rotate, setRotate] = useState(initial.defaultZoomRotateEveryWeeks)
  const [zoomHostEmail, setZoomHostEmail] = useState(initial.zoomHostEmail)
  const [zoomAutoCreate, setZoomAutoCreate] = useState(initial.zoomAutoCreate)
  const [zoomSendRecordings, setZoomSendRecordings] = useState(initial.zoomSendRecordings)
  const [zoomTrashAfterSend, setZoomTrashAfterSend] = useState(initial.zoomTrashAfterSend)

  const save = trpc.webinar.settings.update.useMutation({
    onSuccess: () => toast.success('Settings saved'),
    onError: (e) => toast.error(e.message),
  })
  const testZoom = trpc.webinar.zoom.testConnection.useMutation({
    onSuccess: (r) => {
      if (r.ok) toast.success(`Zoom connected as ${r.email}`)
      else toast.error(r.error)
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          fromName,
          emailSubjectTemplate: subjectTpl,
          emailBodyTemplate: bodyTpl,
          defaultSendDaysOfWeek: sendDays,
          defaultSendHourLocal: sendHour,
          defaultZoomRotateEveryWeeks: rotate,
          zoomHostEmail,
          zoomAutoCreate,
          zoomSendRecordings,
          zoomTrashAfterSend,
        })
      }}
    >
      <Card>
        <CardBody className="space-y-3">
          <h2 className="text-sm font-semibold text-neutral-900">Email template</h2>
          <p className="text-xs text-neutral-500">
            Use placeholders:{' '}
            {PLACEHOLDERS.map((p) => (
              <code key={p} className="mr-1 rounded bg-neutral-100 px-1 py-0.5 text-[11px]">
                {'{{' + p + '}}'}
              </code>
            ))}
          </p>
          <Field label="From name" htmlFor="fromName">
            <Input
              id="fromName"
              value={fromName}
              placeholder="The StudyMind team"
              onChange={(e) => setFromName(e.target.value)}
              disabled={!canManage}
            />
          </Field>
          <Field label="Subject line" htmlFor="subjectTpl">
            <Input
              id="subjectTpl"
              value={subjectTpl}
              onChange={(e) => setSubjectTpl(e.target.value)}
              disabled={!canManage}
            />
          </Field>
          <Field label="Body" htmlFor="bodyTpl">
            <Textarea
              id="bodyTpl"
              rows={14}
              value={bodyTpl}
              onChange={(e) => setBodyTpl(e.target.value)}
              disabled={!canManage}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <h2 className="text-sm font-semibold text-neutral-900">Reminder defaults</h2>
          <p className="text-xs text-neutral-500">
            Applied to new classes (and any class that doesn&apos;t override them). Emails send from
            <strong> info@studymind.co.uk</strong> (the connected Google mailbox).
          </p>
          <Field label="Default send days" htmlFor="send-days">
            <SendDaysPicker value={sendDays} onChange={setSendDays} disabled={!canManage} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Default send hour (local, 0-23)" htmlFor="send-hour">
              <Input
                id="send-hour"
                type="number"
                min={0}
                max={23}
                value={sendHour}
                onChange={(e) => setSendHour(Number(e.target.value))}
                disabled={!canManage}
              />
            </Field>
            <Field label="Default Zoom rotation (weeks)" htmlFor="rotate">
              <Input
                id="rotate"
                type="number"
                min={0}
                max={52}
                value={rotate}
                onChange={(e) => setRotate(Number(e.target.value))}
                disabled={!canManage}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">Zoom integration</h2>
            <span
              className={
                'rounded px-2 py-0.5 text-xs ' +
                (initial.zoomConnected
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-neutral-100 text-neutral-500')
              }
            >
              {initial.zoomConnected ? 'Connected' : 'Not connected'}
            </span>
            {initial.zoomConnected && canManage ? (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={testZoom.isPending}
                onClick={() => testZoom.mutate()}
              >
                {testZoom.isPending ? 'Testing…' : 'Test connection'}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-neutral-500">
            {initial.zoomConnected
              ? 'Generate join links per class (open to all + cloud auto-recording) from each class page.'
              : 'Add a Zoom Server-to-Server OAuth app (ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET) to enable link generation and recordings.'}
          </p>
          <Field label="Default Zoom host email" htmlFor="zoom-host" hint="The Zoom user meetings are created under (optional).">
            <Input
              id="zoom-host"
              type="email"
              placeholder="classes@studymind.co.uk"
              value={zoomHostEmail}
              onChange={(e) => setZoomHostEmail(e.target.value)}
              disabled={!canManage || !initial.zoomConnected}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={zoomAutoCreate}
              onChange={(e) => setZoomAutoCreate(e.target.checked)}
              disabled={!canManage || !initial.zoomConnected}
            />
            Auto-generate a Zoom meeting when a new class is created
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={zoomSendRecordings}
              onChange={(e) => setZoomSendRecordings(e.target.checked)}
              disabled={!canManage || !initial.zoomConnected}
            />
            Email each class its cloud recording after the session
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={zoomTrashAfterSend}
              onChange={(e) => setZoomTrashAfterSend(e.target.checked)}
              disabled={!canManage || !initial.zoomConnected || !zoomSendRecordings}
            />
            After sending, move the recording to Zoom Trash (recoverable for 30 days)
          </label>
        </CardBody>
      </Card>

      {canManage ? (
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      ) : null}
    </form>
  )
}
