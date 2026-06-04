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
import { trpc } from '@/lib/trpc/client'

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
      <ZoomCard detail={detail} canManage={canManage} />
      <SyllabusCard detail={detail} canManage={canManage} />
      <SettingsCard detail={detail} canManage={canManage} />
      <EnrollmentsCard classId={detail.id} initial={enrollments} canManage={canManage} />
    </div>
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
          </form>
        ) : (
          <p className="mt-2 text-sm text-neutral-700">{detail.zoomLink ?? '— not set —'}</p>
        )}
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
  const [sendOffsetHours, setSendOffset] = useState(detail.sendOffsetHours)
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
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Class settings</h2>
        <form
          className="grid gap-3 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            update.mutate({
              id: detail.id,
              sendOffsetHours,
              zoomRotateEveryWeeks: rotate,
              active,
            })
          }}
        >
          <Field label="Send email this many hours before" htmlFor="offset">
            <Input
              id="offset"
              type="number"
              min={0}
              max={168}
              value={sendOffsetHours}
              onChange={(e) => setSendOffset(Number(e.target.value))}
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
          <div className="md:col-span-3">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
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
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">
          Enrolments ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No one enrolled yet. Use <strong>Detect from Stripe</strong> on the Enrolments page.
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
