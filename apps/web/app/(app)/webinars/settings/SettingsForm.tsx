'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

import type { WebinarSettingsView as Settings } from '../types'

// Webinar Settings is now just the platform connections. Email templates +
// send schedules live per group (CLAUDE.md §47) to avoid duplication.
export function SettingsForm({ initial, canManage }: { initial: Settings; canManage: boolean }) {
  const [rotate, setRotate] = useState(initial.defaultZoomRotateEveryWeeks)
  const [zoomHostEmail, setZoomHostEmail] = useState(initial.zoomHostEmail)
  const [zoomAutoCreate, setZoomAutoCreate] = useState(initial.zoomAutoCreate)
  const [zoomSendRecordings, setZoomSendRecordings] = useState(initial.zoomSendRecordings)
  const [zoomTrashAfterSend, setZoomTrashAfterSend] = useState(initial.zoomTrashAfterSend)
  const [senderAddress, setSenderAddress] = useState(initial.senderAddress ?? '')
  const [rotationReminderEmail, setRotationReminderEmail] = useState(
    initial.rotationReminderEmail ?? '',
  )

  const senderOptionsQ = trpc.webinar.settings.senderOptions.useQuery()
  const senderOptions = senderOptionsQ.data
  const selectedMailbox = senderOptions?.mailboxes.find((m) => m.address === senderAddress)

  // Zoom connect-from-Settings (ADR 0035 amendment): paste the three
  // Server-to-Server app values; verified live and stored encrypted.
  const [zAccountId, setZAccountId] = useState('')
  const [zClientId, setZClientId] = useState('')
  const [zClientSecret, setZClientSecret] = useState('')

  const utils = trpc.useUtils()
  const zoomStatus = trpc.webinar.zoom.status.useQuery()
  const zoomConfigured = zoomStatus.data?.configured ?? initial.zoomConnected

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
  const connectZoom = trpc.webinar.zoom.connect.useMutation({
    onSuccess: (r) => {
      toast.success(`Zoom connected${r.email ? ` as ${r.email}` : ''}`)
      setZClientSecret('')
      void utils.webinar.zoom.status.invalidate()
      void utils.webinar.settings.get.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const disconnectZoom = trpc.webinar.zoom.disconnect.useMutation({
    onSuccess: () => {
      toast.success('Zoom disconnected')
      void utils.webinar.zoom.status.invalidate()
      void utils.webinar.settings.get.invalidate()
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
          senderAddress: senderAddress || null,
          rotationReminderEmail: rotationReminderEmail.trim(),
          // Keep the audit actor aligned with the chosen mailbox (null = default).
          senderMailboxUserId: selectedMailbox?.userId ?? null,
        })
      }}
    >
      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-neutral-900">Emails are set per group</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Each group has its own weekly email — edit the template, send days and times on the
            group&apos;s page, with a live preview and a “send test to me” button.
          </p>
          <Link
            href="/webinars/groups"
            className="mt-2 inline-block text-sm text-primary-700 hover:underline"
          >
            Go to Groups →
          </Link>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-neutral-900">Reminders are sent from</h2>
          <p className="mt-1 text-sm text-neutral-600">
            The email address every weekly reminder, class email and recording is sent from.
          </p>
          <div className="mt-3 max-w-md">
            <Field label="Send from" htmlFor="sender-address">
              <Select
                id="sender-address"
                value={senderAddress}
                onChange={(e) => setSenderAddress(e.target.value)}
                disabled={!canManage}
              >
                <option value="">
                  System default ({senderOptions?.systemDefault ?? 'info@studymind.co.uk'})
                </option>
                {senderOptions?.mailboxes.map((m) => (
                  <option key={m.address} value={m.address}>
                    {m.address}
                    {m.isDefault ? ' — default mailbox' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {senderOptions && senderOptions.mailboxes.length === 0 ? (
              <p className="mt-2 text-xs text-neutral-500">
                Only the system default is available. Connect more mailboxes under{' '}
                <Link href="/settings/email-accounts" className="text-primary-700 hover:underline">
                  Settings → Email accounts
                </Link>{' '}
                to send from another address.
              </p>
            ) : (
              <p className="mt-2 text-xs text-neutral-500">
                Pick a connected mailbox, or leave it on the system default. Send a test from any
                group&apos;s page to confirm the sender.
              </p>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-neutral-900">
            Zoom-link rotation reminders go to
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Class Zoom links rotate automatically. When one can&apos;t be rotated (auto-rotation off,
            Zoom not connected, or a rotation fails), this person is emailed to rotate it by hand.
            Those classes also appear on the Webinars overview. Leave blank to turn the reminder
            email off.
          </p>
          <div className="mt-3 max-w-md">
            <Field label="Reminder email" htmlFor="rotation-reminder-email">
              <Input
                id="rotation-reminder-email"
                type="email"
                value={rotationReminderEmail}
                onChange={(e) => setRotationReminderEmail(e.target.value)}
                placeholder="name@studymind.co.uk"
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
                (zoomConfigured
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-neutral-100 text-neutral-500')
              }
            >
              {zoomConfigured
                ? `Connected${zoomStatus.data?.source === 'settings' ? ` (${zoomStatus.data.accountIdMasked})` : zoomStatus.data?.source === 'env' ? ' (via env vars)' : ''}`
                : 'Not connected'}
            </span>
            {zoomConfigured && canManage ? (
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
            {zoomStatus.data?.source === 'settings' && canManage ? (
              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={disconnectZoom.isPending}
                onClick={() => disconnectZoom.mutate()}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-neutral-500">
            {zoomConfigured
              ? 'Join links are generated per group (open to all + cloud auto-recording) and rotate automatically every 4 weeks unless a group opts out.'
              : 'Connect your Zoom account below — one-time, no server access needed.'}
          </p>
          {!zoomConfigured ? (
            <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs text-neutral-600">
                One-time setup (~2 min): sign in at{' '}
                <a
                  href="https://marketplace.zoom.us/develop/create"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary-700 hover:underline"
                >
                  marketplace.zoom.us
                </a>{' '}
                → <span className="font-medium">Develop → Build App → Server-to-Server OAuth</span>.
                Give it scopes <code className="rounded bg-white px-1">meeting:write:admin</code>,{' '}
                <code className="rounded bg-white px-1">cloud_recording:read:admin</code>,{' '}
                <code className="rounded bg-white px-1">cloud_recording:write:admin</code> and{' '}
                <code className="rounded bg-white px-1">user:read:admin</code>, activate it, then
                copy the three values here. They’re checked live and stored encrypted.
              </p>
              <div className="grid gap-2 md:grid-cols-3">
                <Input
                  placeholder="Account ID"
                  value={zAccountId}
                  onChange={(e) => setZAccountId(e.target.value)}
                  disabled={!canManage}
                />
                <Input
                  placeholder="Client ID"
                  value={zClientId}
                  onChange={(e) => setZClientId(e.target.value)}
                  disabled={!canManage}
                />
                <Input
                  placeholder="Client Secret"
                  type="password"
                  value={zClientSecret}
                  onChange={(e) => setZClientSecret(e.target.value)}
                  disabled={!canManage}
                />
              </div>
              <Button
                type="button"
                size="sm"
                disabled={
                  !canManage ||
                  connectZoom.isPending ||
                  !zAccountId.trim() ||
                  !zClientId.trim() ||
                  !zClientSecret.trim()
                }
                onClick={() =>
                  connectZoom.mutate({
                    accountId: zAccountId.trim(),
                    clientId: zClientId.trim(),
                    clientSecret: zClientSecret.trim(),
                  })
                }
              >
                {connectZoom.isPending ? 'Connecting…' : 'Connect Zoom'}
              </Button>
            </div>
          ) : null}
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
