'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RichTextEditor, type RichTextField } from '@/components/ui/rich-text-editor'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { htmlToPlainText } from '@/lib/html-text'
import { trpc } from '@/lib/trpc/client'

import type { ClassDetailView as Detail, EnrollmentRow } from '../types'

type EnrollmentStatus = 'pending_review' | 'active' | 'paused' | 'expired' | 'cancelled'

type ScheduleRow = Detail['schedule'][number]

const STATUS_TONE: Record<string, 'success' | 'warn' | 'neutral' | 'danger' | 'info'> = {
  active: 'success',
  pending_review: 'warn',
  paused: 'neutral',
  expired: 'danger',
  cancelled: 'neutral',
}

export function GroupWorkspace({
  detail,
  enrollments,
  canManage,
}: {
  detail: Detail
  enrollments: EnrollmentRow[]
  canManage: boolean
}) {
  return (
    <div className="space-y-5">
      <GroupSummaryStrip detail={detail} studentCount={enrollments.length} />
      <ThisWeekCard detail={detail} />
      <ZoomCard detail={detail} canManage={canManage} />
      <SyllabusCard detail={detail} canManage={canManage} />
      {canManage ? <ImportScheduleCard classId={detail.id} cohortId={detail.cohortId} /> : null}
      <SettingsCard detail={detail} canManage={canManage} />
      <EnrollmentsCard classId={detail.id} initial={enrollments} canManage={canManage} />
      {canManage ? <BroadcastCard classId={detail.id} /> : null}
    </div>
  )
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function GroupSummaryStrip({ detail, studentCount }: { detail: Detail; studentCount: number }) {
  const h = Math.floor(detail.startMinute / 60)
  const m = detail.startMinute % 60
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  const week = detail.currentWeek
  const weekLabel =
    week.state === 'in_week' && week.weekNumber
      ? `Week ${week.weekNumber} of ${week.totalWeeks}`
      : week.state === 'not_started'
        ? 'Not started'
        : week.state === 'ended'
          ? 'Term ended'
          : `${week.totalWeeks} weeks`
  const stats: Array<{ label: string; value: string; tone?: 'good' | 'warn' }> = [
    { label: 'When', value: `${WEEKDAY_NAMES[detail.dayOfWeek] ?? '—'}s · ${time}` },
    { label: 'Students', value: String(studentCount) },
    { label: 'This week', value: weekLabel },
    {
      label: 'Zoom',
      value: detail.zoomLink ? 'Set' : 'Needed',
      tone: detail.zoomLink ? 'good' : 'warn',
    },
  ]
  return (
    <Card>
      <CardBody className="!py-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label}>
              <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                {s.label}
              </div>
              <div
                className={
                  'mt-0.5 text-sm font-semibold ' +
                  (s.tone === 'good'
                    ? 'text-emerald-700'
                    : s.tone === 'warn'
                      ? 'text-amber-700'
                      : 'text-neutral-900')
                }
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

const BROADCAST_FIELDS: RichTextField[] = [{ token: '{{first_name}}', label: 'First name' }]

function BroadcastCard({ classId }: { classId: string }) {
  const [channel, setChannel] = useState<'email' | 'whatsapp' | 'sms'>('email')
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const htmlRef = useRef('')
  const [editorKey, setEditorKey] = useState(0)
  const broadcast = trpc.webinar.class.broadcast.useMutation({
    onSuccess: (r) => {
      toast.success(`Sent to ${r.sent} · ${r.failed} failed · ${r.skipped} skipped`)
      setText('')
      setSubject('')
      htmlRef.current = ''
      setEditorKey((k) => k + 1) // clear the rich editor
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-neutral-900">Message everyone on this list</h2>
        <p className="mt-1 text-xs text-neutral-500">
          A one-off message to all active enrolments — e.g. a time change. Use the{' '}
          <strong>Insert field</strong> button (or{' '}
          <code className="rounded bg-neutral-100 px-1">{'{{first_name}}'}</code>) to personalise.
          WhatsApp/SMS go via Trengo under your connected token.
        </p>
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (channel === 'email') {
              const html = htmlRef.current
              broadcast.mutate({
                id: classId,
                channel,
                subject: subject || undefined,
                body: htmlToPlainText(html),
                html,
              })
            } else {
              broadcast.mutate({ id: classId, channel, body: text })
            }
          }}
        >
          <div className="flex gap-1">
            {(['email', 'whatsapp', 'sms'] as const).map((ch) => (
              <button
                key={ch}
                type="button"
                onClick={() => setChannel(ch)}
                className={
                  'rounded-md px-3 py-1.5 text-sm ' +
                  (channel === ch
                    ? 'bg-primary-50 font-medium text-primary-800'
                    : 'text-neutral-600 hover:bg-neutral-100')
                }
              >
                {ch === 'email' ? 'Email' : ch === 'whatsapp' ? 'WhatsApp' : 'SMS'}
              </button>
            ))}
          </div>
          {channel === 'email' ? (
            <>
              <Input
                placeholder="Subject (optional)"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
              <RichTextEditor
                initialHtml=""
                resetKey={editorKey}
                onChange={(html) => {
                  htmlRef.current = html
                }}
                fields={BROADCAST_FIELDS}
              />
            </>
          ) : (
            <Textarea
              rows={4}
              placeholder="Hi {{first_name}}, a quick update about this week's class…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          )}
          <Button
            type="submit"
            disabled={
              broadcast.isPending ||
              (channel !== 'email' && text.trim().length === 0)
            }
          >
            {broadcast.isPending ? 'Sending…' : 'Send to everyone'}
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}

function ThisWeekCard({ detail }: { detail: Detail }) {
  const w = detail.currentWeek
  const headline =
    w.state === 'in_week'
      ? `This week — Week ${w.weekNumber} of ${w.totalWeeks}`
      : w.state === 'not_started'
        ? 'Term not started yet'
        : w.state === 'between'
          ? `On a break — next up Week ${w.weekNumber} of ${w.totalWeeks}`
          : 'Term has ended'
  const tone = w.state === 'in_week' ? 'success' : w.state === 'ended' ? 'neutral' : 'info'
  return (
    <Card className={w.state === 'in_week' ? 'border-emerald-200 bg-emerald-50/40' : undefined}>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Badge tone={tone}>{headline}</Badge>
              {detail.hasUploadedPdf ? (
                <Badge tone="info">PDF schedule attached</Badge>
              ) : (
                <Badge tone="neutral">auto schedule PDF</Badge>
              )}
            </div>
            {w.dateLabel ? (
              <p className="mt-1.5 text-sm text-neutral-700">
                {w.state === 'not_started' ? 'Starts ' : 'Session: '}
                <span className="font-medium">{w.dateLabel}</span>
                {w.timeLabel ? ` at ${w.timeLabel}` : ''}
                {w.topic ? <> — {w.topic}</> : null}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-neutral-500">
              The reminder email reflects this week&apos;s session and attaches the schedule PDF the
              CRM holds.
            </p>
          </div>
          <a
            href={`/webinars/groups/${detail.id}/schedule.pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary-700 hover:underline"
          >
            View schedule PDF →
          </a>
        </div>
      </CardBody>
    </Card>
  )
}

function ZoomCard({ detail, canManage }: { detail: Detail; canManage: boolean }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [link, setLink] = useState(detail.zoomLink ?? '')
  const save = trpc.webinar.class.setZoomLink.useMutation({
    onSuccess: () => {
      toast.success('Zoom link updated — rotation reminder cleared')
      void utils.webinar.class.get.invalidate({ id: detail.id })
      router.refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const settings = trpc.webinar.settings.get.useQuery()
  const generate = trpc.webinar.class.generateZoomLink.useMutation({
    onSuccess: ({ joinUrl }) => {
      toast.success('Zoom meeting created (open to all, cloud recording on)')
      setLink(joinUrl)
      void utils.webinar.class.get.invalidate({ id: detail.id })
      router.refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const sendRecording = trpc.webinar.class.sendRecordingNow.useMutation({
    onSuccess: (r) => {
      if (r.errors.length > 0) toast.error(r.errors[0])
      else if (r.sent > 0) toast.success('Recording emailed to the class')
      else toast.message('No new recording found to send yet')
    },
    onError: (e) => toast.error(e.message),
  })
  const updated = detail.zoomLinkUpdatedAt ? new Date(detail.zoomLinkUpdatedAt) : null
  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Zoom link</h2>
          <a
            href={`/webinars/groups/${detail.id}/schedule.pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary-700 hover:underline"
          >
            Preview schedule PDF →
          </a>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Sent in every weekly email. Rotates every {detail.zoomRotateEveryWeeks} weeks
          {updated ? ` · last updated ${updated.toLocaleDateString('en-GB')}` : ' · never set'}.
        </p>
        {canManage ? (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate({ id: detail.id, zoomLink: link })
            }}
          >
            <Input
              type="url"
              placeholder="https://zoom.us/j/…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              required
            />
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Update link'}
            </Button>
            {settings.data?.zoomConnected ? (
              <Button
                type="button"
                variant="secondary"
                disabled={generate.isPending}
                onClick={() => generate.mutate({ id: detail.id })}
              >
                {generate.isPending ? 'Generating…' : detail.zoomLink ? 'Regenerate via Zoom' : 'Generate via Zoom'}
              </Button>
            ) : null}
            {settings.data?.zoomConnected && detail.zoomLink ? (
              <Button
                type="button"
                variant="ghost"
                disabled={sendRecording.isPending}
                onClick={() => sendRecording.mutate({ id: detail.id })}
              >
                {sendRecording.isPending ? 'Sending…' : 'Send recording now'}
              </Button>
            ) : null}
          </form>
        ) : (
          <p className="mt-2 text-sm text-neutral-700">{detail.zoomLink ?? '— not set —'}</p>
        )}
        {settings.data && !settings.data.zoomConnected ? (
          <p className="mt-2 text-xs text-neutral-400">
            Connect a Zoom account in Settings to auto-generate links (open to all + auto-recording).
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

function SyllabusCard({ detail, canManage }: { detail: Detail; canManage: boolean }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [rows, setRows] = useState<ScheduleRow[]>(detail.schedule)

  const refresh = () => {
    void utils.webinar.class.get.invalidate({ id: detail.id })
    router.refresh()
  }
  const generate = trpc.webinar.syllabus.generate.useMutation({
    onSuccess: () => {
      toast.success('Generated a week per session')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const setSyllabus = trpc.webinar.syllabus.set.useMutation({
    onSuccess: () => {
      toast.success('Syllabus saved')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const uploadPdf = trpc.webinar.class.uploadSyllabusPdf.useMutation({
    onSuccess: () => {
      toast.success('PDF uploaded — it will be attached instead of the generated schedule')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const removePdf = trpc.webinar.class.removeSyllabusPdf.useMutation({
    onSuccess: () => {
      toast.success('PDF removed')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const buf = await file.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
    uploadPdf.mutate({ id: detail.id, fileName: file.name, dataBase64: base64 })
    e.target.value = ''
  }

  function saveTopics() {
    const weeks = rows
      .filter((r) => r.topic.trim().length > 0)
      .map((r) => ({ weekNumber: r.weekNumber, topic: r.topic.trim() }))
    setSyllabus.mutate({ classId: detail.id, weeks })
  }

  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Weekly classes</h2>
            <p className="mt-1 text-xs text-neutral-500">
              {detail.sessionCount} weekly classes this term (holidays excluded). Type the topic for
              each, or upload a ready-made PDF.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {detail.hasUploadedPdf ? (
              <Badge tone="info">PDF: {detail.uploadedPdfFileName}</Badge>
            ) : null}
            <a
              href={`/webinars/groups/${detail.id}/schedule.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center rounded-md border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Preview schedule PDF
            </a>
          </div>
        </div>

        {canManage ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => generate.mutate({ classId: detail.id })}>
              Generate weeks
            </Button>
            <label className="inline-flex">
              <span className="inline-flex h-8 cursor-pointer items-center rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-800 shadow-sm hover:bg-neutral-50">
                Upload syllabus PDF
              </span>
              <input type="file" accept="application/pdf" className="hidden" onChange={onFile} />
            </label>
            {detail.hasUploadedPdf ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removePdf.mutate({ id: detail.id })}
              >
                Remove PDF
              </Button>
            ) : null}
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="mt-4 space-y-1.5">
            {rows.map((r, i) => (
              <div key={r.weekNumber} className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs text-neutral-500">
                  W{r.weekNumber} · {r.dateLabel}
                </span>
                {canManage ? (
                  <Input
                    value={r.topic}
                    placeholder="Topic for this week"
                    onChange={(e) => {
                      const next = [...rows]
                      next[i] = { ...r, topic: e.target.value }
                      setRows(next)
                    }}
                  />
                ) : (
                  <span className="text-sm text-neutral-700">{r.topic || '—'}</span>
                )}
              </div>
            ))}
            {canManage ? (
              <div className="pt-2">
                <Button size="sm" onClick={saveTopics} disabled={setSyllabus.isPending}>
                  {setSyllabus.isPending ? 'Saving…' : 'Save topics'}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-sm text-neutral-500">
            No schedule yet — press <strong>Generate weeks</strong> to lay out the term.
          </p>
        )}
      </CardBody>
    </Card>
  )
}

function minuteToTime(startMinute: number): string {
  const h = Math.floor(startMinute / 60)
  const m = startMinute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function SettingsCard({ detail, canManage }: { detail: Detail; canManage: boolean }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [day, setDay] = useState(detail.dayOfWeek)
  const [time, setTime] = useState(minuteToTime(detail.startMinute))
  const [rotate, setRotate] = useState(detail.zoomRotateEveryWeeks)
  const [active, setActive] = useState(detail.active)
  const update = trpc.webinar.class.update.useMutation({
    onSuccess: () => {
      toast.success('Saved')
      void utils.webinar.class.get.invalidate({ id: detail.id })
      router.refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  if (!canManage) return null
  return (
    <Card>
      <CardBody>
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Group settings</h2>
        <p className="mb-3 text-xs text-neutral-500">
          When the class meets, the Zoom rotation and status. The reminder email and term dates are
          further down this page.
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            const [h, m] = time.split(':').map(Number)
            update.mutate({
              id: detail.id,
              dayOfWeek: day,
              startMinute: (h ?? 0) * 60 + (m ?? 0),
              zoomRotateEveryWeeks: rotate,
              active,
            })
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Meets on" htmlFor="meets-day">
              <Select id="meets-day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {WEEKDAY_NAMES.map((d, i) => (
                  <option key={d} value={i}>
                    {d}s
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Start time" htmlFor="meets-time">
              <Input id="meets-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
            <Field label="Rotate Zoom link every (weeks)" htmlFor="rotate">
              <Input
                id="rotate"
                type="number"
                min={0}
                max={52}
                value={rotate}
                onChange={(e) => setRotate(Number(e.target.value))}
              />
            </Field>
            <Field label="Status" htmlFor="active">
              <Select
                id="active"
                value={active ? 'yes' : 'no'}
                onChange={(e) => setActive(e.target.value === 'yes')}
              >
                <option value="yes">Active</option>
                <option value="no">Inactive (paused)</option>
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </form>
      </CardBody>
    </Card>
  )
}

function EnrollmentsCard({
  classId,
  initial,
  canManage,
}: {
  classId: string
  initial: EnrollmentRow[]
  canManage: boolean
}) {
  const utils = trpc.useUtils()
  const list = trpc.webinar.enrollment.list.useQuery({ classId }, { initialData: initial })
  const setStatus = trpc.webinar.enrollment.setStatus.useMutation({
    onSuccess: () => void utils.webinar.enrollment.list.invalidate({ classId }),
    onError: (e) => toast.error(e.message),
  })
  const remove = trpc.webinar.enrollment.remove.useMutation({
    onSuccess: () => void utils.webinar.enrollment.list.invalidate({ classId }),
    onError: (e) => toast.error(e.message),
  })
  const [filter, setFilter] = useState<'all' | EnrollmentStatus>('all')
  const rows = list.data ?? []

  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  const visible = filter === 'all' ? rows : rows.filter((r) => r.status === filter)

  const FILTERS: Array<{ key: 'all' | EnrollmentStatus; label: string }> = [
    { key: 'all', label: `All ${rows.length}` },
    { key: 'active', label: `Active ${counts['active'] ?? 0}` },
    { key: 'pending_review', label: `Pending ${counts['pending_review'] ?? 0}` },
    { key: 'paused', label: `Paused ${counts['paused'] ?? 0}` },
    { key: 'expired', label: `Expired ${counts['expired'] ?? 0}` },
  ]

  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">
            Students <span className="font-normal text-neutral-400">({rows.length})</span>
          </h2>
          <span className="text-xs text-neutral-500">
            {counts['active'] ?? 0} active
            {counts['pending_review'] ? ` · ${counts['pending_review']} to review` : ''}
          </span>
        </div>

        {rows.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={
                  'rounded-full px-2.5 py-0.5 text-xs ' +
                  (filter === f.key
                    ? 'bg-primary-600 font-medium text-white'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200')
                }
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : null}

        {canManage ? (
          <div className="mt-3">
            <AddToList
              classId={classId}
              onAdded={() => void utils.webinar.enrollment.list.invalidate({ classId })}
            />
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No students yet. Add someone above, or use <strong>Detect from Stripe</strong> on the
            Enrolments page to pull in active subscribers automatically.
          </p>
        ) : visible.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">No {filter.replace('_', ' ')} students.</p>
        ) : (
          <div className="mt-3 divide-y divide-neutral-100">
            {visible.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-50 text-xs font-semibold text-primary-700">
                  {studentInitials(e.contactName)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/contacts/${e.contactId}`}
                      className="truncate text-sm font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                    >
                      {e.contactName}
                    </Link>
                    <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>
                      {e.status.replace('_', ' ')}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
                    {e.contactEmail ? <span className="truncate">{e.contactEmail}</span> : null}
                    {e.billingInterval ? (
                      <span>· {e.billingInterval === 'year' ? 'yearly' : 'monthly'}</span>
                    ) : null}
                    {e.expiresAt ? (
                      <span>· until {new Date(e.expiresAt).toLocaleDateString('en-GB')}</span>
                    ) : null}
                  </div>
                </div>
                {canManage ? (
                  <div className="flex items-center gap-1.5">
                    <Select
                      className="h-8 text-xs"
                      value={e.status}
                      onChange={(ev) =>
                        setStatus.mutate({ id: e.id, status: ev.target.value as EnrollmentStatus })
                      }
                    >
                      <option value="active">Active</option>
                      <option value="pending_review">Pending review</option>
                      <option value="paused">Paused</option>
                      <option value="expired">Expired</option>
                      <option value="cancelled">Cancelled</option>
                    </Select>
                    <Button variant="ghost" size="xs" onClick={() => remove.mutate({ id: e.id })}>
                      Remove
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/** Up-to-two-letter initials for a student avatar. */
function studentInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0]![0]! + (parts[1]?.[0] ?? '')).toUpperCase()
}

interface DetectedHoliday {
  name: string
  startsOn: string
  endsOn: string
  keep: boolean
}

function ImportScheduleCard({ classId, cohortId }: { classId: string; cohortId: string }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [kind, setKind] = useState<'text' | 'csv' | 'pdf'>('text')
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Array<{ weekNumber: number; topic: string }>>([])
  const [holidays, setHolidays] = useState<DetectedHoliday[]>([])
  const [note, setNote] = useState<string>('')

  const addHoliday = trpc.webinar.cohort.addHoliday.useMutation()

  const preview = trpc.webinar.syllabus.importPreview.useMutation({
    onSuccess: (r) => {
      setRows(r.weeks)
      setHolidays(r.holidays.map((h) => ({ ...h, keep: true })))
      setNote(r.note)
      if (r.weeks.length === 0 && r.holidays.length === 0) toast.error(r.note)
    },
    onError: (e) => toast.error(e.message),
  })
  const save = trpc.webinar.syllabus.set.useMutation({
    onSuccess: async () => {
      // After saving the weeks, persist any confirmed holidays to the cohort.
      const keep = holidays.filter((h) => h.keep)
      for (const h of keep) {
        try {
          await addHoliday.mutateAsync({
            cohortId,
            name: h.name,
            startsOn: h.startsOn,
            endsOn: h.endsOn,
          })
        } catch {
          // best-effort; a bad date just won't be added
        }
      }
      toast.success(
        keep.length > 0
          ? `Schedule saved · ${keep.length} holiday${keep.length === 1 ? '' : 's'} added`
          : 'Schedule saved to the syllabus',
      )
      setRows([])
      setHolidays([])
      setText('')
      void utils.webinar.class.get.invalidate({ id: classId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  async function fileToBase64(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const buf = await file.arrayBuffer()
    // Chunked to avoid call-stack limits on large files.
    let binary = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    const base64 = btoa(binary)
    preview.mutate({ classId, kind, dataBase64: base64 })
    e.target.value = ''
  }

  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-neutral-900">Import schedule (AI)</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Paste your schedule, or upload a CSV or PDF. The app uses AI to pull out the weekly topics
          <strong> and any holidays/breaks</strong> — review and save. Holidays are added to this
          group&apos;s academic year so no emails go out on those dates. The uploaded PDF (if any) is
          still attached to every email.
        </p>

        <div className="mt-3 flex gap-1">
          {(['text', 'csv', 'pdf'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={
                'rounded-md px-3 py-1.5 text-sm ' +
                (kind === k
                  ? 'bg-primary-50 font-medium text-primary-800'
                  : 'text-neutral-600 hover:bg-neutral-100')
              }
            >
              {k === 'text' ? 'Paste' : k.toUpperCase()}
            </button>
          ))}
        </div>

        {kind === 'text' ? (
          <div className="mt-2 space-y-2">
            <Textarea
              rows={6}
              placeholder={'Week 1: Cell structure\nWeek 2: Transport in cells\n…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <Button
              size="sm"
              disabled={preview.isPending || text.trim().length === 0}
              onClick={() => preview.mutate({ classId, kind: 'text', text })}
            >
              {preview.isPending ? 'Reading…' : 'Preview import'}
            </Button>
          </div>
        ) : (
          <div className="mt-2">
            <label className="inline-flex">
              <span className="inline-flex h-8 cursor-pointer items-center rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-800 shadow-sm hover:bg-neutral-50">
                {preview.isPending ? 'Reading…' : `Choose ${kind.toUpperCase()} file`}
              </span>
              <input
                type="file"
                accept={kind === 'pdf' ? 'application/pdf' : '.csv,text/csv,text/plain'}
                className="hidden"
                onChange={fileToBase64}
              />
            </label>
          </div>
        )}

        {rows.length > 0 || holidays.length > 0 ? (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-neutral-500">{note}</p>

            {rows.length > 0 ? (
              <div className="space-y-1.5">
                {rows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-xs text-neutral-500">W{r.weekNumber}</span>
                    <Input
                      value={r.topic}
                      onChange={(e) => {
                        const next = [...rows]
                        next[i] = { ...r, topic: e.target.value }
                        setRows(next)
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {holidays.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3">
                <p className="text-xs font-medium text-amber-900">
                  Holidays detected in the timetable — these are added to this group&apos;s academic
                  year (no emails on these dates):
                </p>
                <div className="mt-2 space-y-1">
                  {holidays.map((h, i) => (
                    <label key={i} className="flex items-center gap-2 text-sm text-neutral-700">
                      <input
                        type="checkbox"
                        checked={h.keep}
                        onChange={(e) => {
                          const next = [...holidays]
                          next[i] = { ...h, keep: e.target.checked }
                          setHolidays(next)
                        }}
                      />
                      <span className="font-medium">{h.name}</span>
                      <span className="text-neutral-500">
                        {h.startsOn} → {h.endsOn}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                disabled={save.isPending || addHoliday.isPending}
                onClick={async () => {
                  const weeks = rows.filter((r) => r.topic.trim().length > 0)
                  if (weeks.length > 0) {
                    // Saves weeks, then adds confirmed holidays in onSuccess.
                    save.mutate({ classId, weeks })
                    return
                  }
                  // Holidays only — don't wipe the syllabus with an empty set.
                  const keep = holidays.filter((h) => h.keep)
                  if (keep.length === 0) {
                    toast.error('Nothing selected to save')
                    return
                  }
                  for (const h of keep) {
                    try {
                      await addHoliday.mutateAsync({
                        cohortId,
                        name: h.name,
                        startsOn: h.startsOn,
                        endsOn: h.endsOn,
                      })
                    } catch {
                      /* skip bad date */
                    }
                  }
                  toast.success(`${keep.length} holiday${keep.length === 1 ? '' : 's'} added`)
                  setHolidays([])
                  setRows([])
                  setText('')
                  router.refresh()
                }}
              >
                {save.isPending || addHoliday.isPending
                  ? 'Saving…'
                  : rows.length > 0
                    ? `Save ${rows.length} weeks${holidays.some((h) => h.keep) ? ' + holidays' : ''}`
                    : 'Add holidays'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRows([])
                  setHolidays([])
                }}
              >
                Discard
              </Button>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u

function AddToList({ classId, onAdded }: { classId: string; onAdded: () => void }) {
  const [term, setTerm] = useState('')
  const [name, setName] = useState('')
  const search = trpc.webinar.enrollment.contactSearch.useQuery(
    { term },
    { enabled: term.trim().length >= 2 },
  )
  const create = trpc.webinar.enrollment.create.useMutation({
    onSuccess: () => {
      toast.success('Added to the mailing list')
      setTerm('')
      setName('')
      onAdded()
    },
    onError: (e) => toast.error(e.message),
  })
  const results = search.data ?? []
  const typedEmail = EMAIL_SHAPE.test(term.trim()) ? term.trim().toLowerCase() : null
  return (
    <div className="mb-3">
      <Input
        placeholder="Add by name, or type any email address…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      {term.trim().length >= 2 && (results.length > 0 || typedEmail) ? (
        <div className="mt-1 divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-neutral-50"
              onClick={() => create.mutate({ classId, contactId: c.id, status: 'active' })}
            >
              <span>
                <span className="font-medium text-neutral-800">{c.name}</span>{' '}
                <span className="text-neutral-500">{c.email}</span>
              </span>
              <span className="text-xs text-primary-700">Add →</span>
            </button>
          ))}
          {/* Anyone by email — no CRM record needed; one is created (or the
              existing one matched) behind the scenes so the weekly send and
              timeline work as normal. */}
          {typedEmail && !results.some((c) => c.email?.toLowerCase() === typedEmail) ? (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="text-sm text-neutral-700">
                Add <span className="font-medium">{typedEmail}</span> to the list
              </span>
              <Input
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 w-44 text-xs"
              />
              <Button
                type="button"
                size="sm"
                disabled={create.isPending}
                onClick={() =>
                  create.mutate({
                    classId,
                    email: typedEmail,
                    name: name.trim() || undefined,
                    status: 'active',
                  })
                }
              >
                {create.isPending ? 'Adding…' : 'Add email →'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
