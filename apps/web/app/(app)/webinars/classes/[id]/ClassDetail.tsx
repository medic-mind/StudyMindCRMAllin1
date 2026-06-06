'use client'

import { useState } from 'react'
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

import { SendDaysPicker } from '../../SendDaysPicker'
import type { ClassDetailView as Detail, EnrollmentRow } from '../../types'

type EnrollmentStatus = 'pending_review' | 'active' | 'paused' | 'expired' | 'cancelled'

type ScheduleRow = Detail['schedule'][number]

const STATUS_TONE: Record<string, 'success' | 'warn' | 'neutral' | 'danger' | 'info'> = {
  active: 'success',
  pending_review: 'warn',
  paused: 'neutral',
  expired: 'danger',
  cancelled: 'neutral',
}

export function ClassDetail({
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
      <ThisWeekCard detail={detail} />
      <ZoomCard detail={detail} canManage={canManage} />
      <SyllabusCard detail={detail} canManage={canManage} />
      {canManage ? <ImportScheduleCard classId={detail.id} /> : null}
      <SettingsCard detail={detail} canManage={canManage} />
      <EnrollmentsCard classId={detail.id} initial={enrollments} canManage={canManage} />
    </div>
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
            href={`/webinars/classes/${detail.id}/schedule.pdf`}
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
  const updated = detail.zoomLinkUpdatedAt ? new Date(detail.zoomLinkUpdatedAt) : null
  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Zoom link</h2>
          <a
            href={`/webinars/classes/${detail.id}/schedule.pdf`}
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
                {generate.isPending ? 'Generating…' : 'Generate via Zoom'}
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
            <h2 className="text-sm font-semibold text-neutral-900">Syllabus &amp; schedule</h2>
            <p className="mt-1 text-xs text-neutral-500">
              {detail.sessionCount} teaching weeks (holidays excluded). Type the weekly topics, or
              upload a ready-made PDF.
            </p>
          </div>
          {detail.hasUploadedPdf ? (
            <Badge tone="info">PDF: {detail.uploadedPdfFileName}</Badge>
          ) : null}
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

function SettingsCard({ detail, canManage }: { detail: Detail; canManage: boolean }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [sendDays, setSendDays] = useState<number[]>(detail.sendDaysOfWeek)
  const [sendHour, setSendHour] = useState(detail.sendHourLocal)
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
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Reminder schedule</h2>
        <p className="mb-3 text-xs text-neutral-500">
          A reminder email (Zoom link + PDF) goes out on each selected day of the class&apos;s week,
          from the chosen local hour.
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            update.mutate({
              id: detail.id,
              sendDaysOfWeek: sendDays,
              sendHourLocal: sendHour,
              zoomRotateEveryWeeks: rotate,
              active,
            })
          }}
        >
          <Field label="Send on these days" htmlFor="send-days">
            <SendDaysPicker value={sendDays} onChange={setSendDays} />
          </Field>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Send from (local hour)" htmlFor="send-hour">
              <Input
                id="send-hour"
                type="number"
                min={0}
                max={23}
                value={sendHour}
                onChange={(e) => setSendHour(Number(e.target.value))}
              />
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
  const rows = list.data ?? []
  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Mailing list ({rows.length})</h2>
        </div>
        {canManage ? (
          <AddToList
            classId={classId}
            onAdded={() => void utils.webinar.enrollment.list.invalidate({ classId })}
          />
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No one on the list yet. Add someone above, or use <strong>Detect from Stripe</strong> on
            the Enrolments page.
          </p>
        ) : (
          <div className="space-y-1.5">
            {rows.map((e) => (
              <div
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded bg-neutral-50 px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium text-neutral-800">{e.contactName}</span>{' '}
                  <span className="text-neutral-500">{e.contactEmail}</span>
                  {e.billingInterval ? (
                    <Badge tone="neutral" className="ml-2">
                      {e.billingInterval === 'year' ? 'yearly' : 'monthly'}
                    </Badge>
                  ) : null}
                  {e.expiresAt ? (
                    <span className="ml-2 text-xs text-neutral-400">
                      access to {new Date(e.expiresAt).toLocaleDateString('en-GB')}
                    </span>
                  ) : null}
                  {e.matchReason ? (
                    <span className="ml-2 text-xs text-neutral-400">{e.matchReason}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
                  {canManage ? (
                    <>
                      <Select
                        value={e.status}
                        onChange={(ev) =>
                          setStatus.mutate({
                            id: e.id,
                            status: ev.target.value as EnrollmentStatus,
                          })
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
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function ImportScheduleCard({ classId }: { classId: string }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [kind, setKind] = useState<'text' | 'csv' | 'pdf'>('text')
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Array<{ weekNumber: number; topic: string }>>([])
  const [note, setNote] = useState<string>('')

  const preview = trpc.webinar.syllabus.importPreview.useMutation({
    onSuccess: (r) => {
      setRows(r.weeks)
      setNote(r.note)
      if (r.weeks.length === 0) toast.error(r.note)
    },
    onError: (e) => toast.error(e.message),
  })
  const save = trpc.webinar.syllabus.set.useMutation({
    onSuccess: () => {
      toast.success('Schedule saved to the syllabus')
      setRows([])
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
          — review and save. The uploaded PDF (if any) is still attached to every email.
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

        {rows.length > 0 ? (
          <div className="mt-4 space-y-1.5">
            <p className="text-xs text-neutral-500">{note}</p>
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
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    classId,
                    weeks: rows.filter((r) => r.topic.trim().length > 0),
                  })
                }
              >
                {save.isPending ? 'Saving…' : `Save ${rows.length} weeks to syllabus`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRows([])}>
                Discard
              </Button>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

function AddToList({ classId, onAdded }: { classId: string; onAdded: () => void }) {
  const [term, setTerm] = useState('')
  const search = trpc.webinar.enrollment.contactSearch.useQuery(
    { term },
    { enabled: term.trim().length >= 2 },
  )
  const create = trpc.webinar.enrollment.create.useMutation({
    onSuccess: () => {
      toast.success('Added to the mailing list')
      setTerm('')
      onAdded()
    },
    onError: (e) => toast.error(e.message),
  })
  const results = search.data ?? []
  return (
    <div className="mb-3">
      <Input
        placeholder="Add a contact by name or email…"
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
              onClick={() => create.mutate({ classId, contactId: c.id, status: 'active' })}
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
