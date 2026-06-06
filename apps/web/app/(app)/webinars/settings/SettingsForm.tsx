'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

import type { WebinarSettingsView as Settings } from '../types'

// Webinar Settings is now just the platform connections. Email templates +
// send schedules live per cohort (CLAUDE.md §47) to avoid duplication.
export function SettingsForm({ initial, canManage }: { initial: Settings; canManage: boolean }) {
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
          defaultZoomRotateEveryWeeks: rotate,
          zoomHostEmail,
          zoomAutoCreate,
          zoomSendRecordings,
          zoomTrashAfterSend,
        })
      }}
    >
      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-neutral-900">Emails are set per cohort</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Each cohort has its own weekly email template, from-name and send days/times. Open a
            cohort to edit them — they apply to every class in that year.
          </p>
          <Link
            href="/webinars/cohorts"
            className="mt-2 inline-block text-sm text-primary-700 hover:underline"
          >
            Go to Cohorts →
          </Link>
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
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Default Zoom host email"
              htmlFor="zoom-host"
              hint="The Zoom user meetings are created under (optional)."
            >
              <Input
                id="zoom-host"
                type="email"
                placeholder="classes@studymind.co.uk"
                value={zoomHostEmail}
                onChange={(e) => setZoomHostEmail(e.target.value)}
                disabled={!canManage || !initial.zoomConnected}
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
