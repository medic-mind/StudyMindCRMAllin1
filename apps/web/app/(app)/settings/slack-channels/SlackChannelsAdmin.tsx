// CRUD admin for Slack channel options. Inline create + edit, archive +
// restore, plus an editable list of deep-link action buttons per channel.
// Manager+ via the tRPC layer. CLAUDE.md §10/§12.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

interface ActionButton {
  label: string
  url: string
}

interface ChannelOption {
  id: string
  label: string
  channelId: string
  purpose: string | null
  isDefault: boolean
  actionButtons: ActionButton[]
  sortOrder: number
  archived: boolean
}

export function SlackChannelsAdmin() {
  const router = useRouter()
  const listQuery = trpc.slackChannel.list.useQuery({ includeArchived: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const channels = listQuery.data ?? []

  async function refresh() {
    await listQuery.refetch()
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-neutral-600">
          When an agent records a call summary, the <em>Internal — Slack</em> section
          lets them post it to one of these channels for the virtual-assistant team to
          action. The <strong>default</strong> channel is pre-selected. Action buttons
          appear under the message in Slack — use{' '}
          <code className="rounded bg-neutral-100 px-1">{'{{contactUrl}}'}</code> to link
          back to the contact.
        </p>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            New channel
          </Button>
        )}
      </div>

      {creating && (
        <ChannelEditor
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      )}

      {listQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : channels.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No Slack channels configured yet. Until you add one, call summaries fall back
          to the channel set in <code className="rounded bg-neutral-100 px-1">SLACK_ALERTS_CHANNEL_ID</code>.
        </p>
      ) : (
        <ul className="space-y-3">
          {channels.map((c) =>
            editingId === c.id ? (
              <li key={c.id}>
                <ChannelEditor
                  mode="edit"
                  channel={c}
                  onClose={() => setEditingId(null)}
                  onSaved={refresh}
                />
              </li>
            ) : (
              <li
                key={c.id}
                className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card"
              >
                <ChannelRow
                  channel={c}
                  onEdit={() => setEditingId(c.id)}
                  onChanged={refresh}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function ChannelRow({
  channel,
  onEdit,
  onChanged,
}: {
  channel: ChannelOption
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const archive = trpc.slackChannel.archive.useMutation()
  const restore = trpc.slackChannel.restore.useMutation()
  const [busy, setBusy] = useState(false)

  async function toggleArchive() {
    setBusy(true)
    try {
      if (channel.archived) {
        await restore.mutateAsync({ id: channel.id })
        toast.success('Channel restored')
      } else {
        await archive.mutateAsync({ id: channel.id })
        toast.success('Channel archived')
      }
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">{channel.label}</h3>
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-700">
            {channel.channelId}
          </code>
          {channel.isDefault && (
            <span className="rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-800">
              Default
            </span>
          )}
          {channel.archived && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
              Archived
            </span>
          )}
        </div>
        {channel.purpose && <p className="text-xs text-neutral-600">{channel.purpose}</p>}
        {channel.actionButtons.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {channel.actionButtons.map((b, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px] text-neutral-700"
                title={b.url}
              >
                {b.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-end">
        <Button type="button" size="sm" variant="secondary" onClick={onEdit}>
          Edit
        </Button>
        <button
          type="button"
          onClick={toggleArchive}
          disabled={busy}
          className="text-xs text-neutral-600 hover:underline"
        >
          {channel.archived ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  )
}

function ChannelEditor({
  mode,
  channel,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  channel?: ChannelOption
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [label, setLabel] = useState(channel?.label ?? '')
  const [channelId, setChannelId] = useState(channel?.channelId ?? '')
  const [purpose, setPurpose] = useState(channel?.purpose ?? '')
  const [isDefault, setIsDefault] = useState(channel?.isDefault ?? false)
  const [sortOrder, setSortOrder] = useState(channel?.sortOrder ?? 100)
  const [buttons, setButtons] = useState<ActionButton[]>(
    channel?.actionButtons ?? [{ label: 'Open in CRM', url: '{{contactUrl}}' }],
  )
  const [busy, setBusy] = useState(false)

  const create = trpc.slackChannel.create.useMutation()
  const update = trpc.slackChannel.update.useMutation()

  function setButton(i: number, patch: Partial<ActionButton>) {
    setButtons((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))
  }
  function addButton() {
    if (buttons.length >= 5) return
    setButtons((prev) => [...prev, { label: '', url: '{{contactUrl}}' }])
  }
  function removeButton(i: number) {
    setButtons((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function save() {
    if (!label.trim() || !channelId.trim()) {
      toast.error('Label and channel id are required.')
      return
    }
    // Drop empty button rows; keep ones with both fields filled.
    const cleaned = buttons
      .map((b) => ({ label: b.label.trim(), url: b.url.trim() }))
      .filter((b) => b.label.length > 0 && b.url.length > 0)
    setBusy(true)
    try {
      if (mode === 'create') {
        await create.mutateAsync({
          label: label.trim(),
          channelId: channelId.trim().toUpperCase(),
          purpose: purpose.trim() || undefined,
          isDefault,
          actionButtons: cleaned,
          sortOrder,
        })
        toast.success('Channel created')
      } else if (channel) {
        await update.mutateAsync({
          id: channel.id,
          label: label.trim(),
          channelId: channelId.trim().toUpperCase(),
          purpose: purpose.trim() || null,
          isDefault,
          actionButtons: cleaned,
          sortOrder,
        })
        toast.success('Channel updated')
      }
      await onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          {mode === 'create' ? 'New channel' : `Edit: ${channel?.label}`}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>
      <Field label="Label" htmlFor="sc-label">
        <Input
          id="sc-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. VA action points"
        />
      </Field>
      <Field label="Slack channel id" htmlFor="sc-channel">
        <Input
          id="sc-channel"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          placeholder="C0123456789"
          className="font-mono"
        />
      </Field>
      <Field label="Purpose (optional)" htmlFor="sc-purpose">
        <Input
          id="sc-purpose"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="What this channel is for."
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Default channel (pre-selected in the send dialog)
      </label>

      <div className="rounded-md border border-neutral-200 bg-white p-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Action buttons ({buttons.length}/5)
          </p>
          <button
            type="button"
            onClick={addButton}
            disabled={buttons.length >= 5}
            className="text-xs text-primary-700 hover:underline disabled:opacity-40"
          >
            + Add button
          </button>
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          Rendered under the Slack message. Use{' '}
          <code className="rounded bg-neutral-100 px-1">{'{{contactUrl}}'}</code> to link to
          the contact.
        </p>
        <div className="mt-2 space-y-2">
          {buttons.length === 0 && (
            <p className="text-xs text-neutral-500">No buttons — the message posts plain.</p>
          )}
          {buttons.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                value={b.label}
                onChange={(e) => setButton(i, { label: e.target.value })}
                placeholder="Button label"
                className="w-40"
              />
              <Input
                value={b.url}
                onChange={(e) => setButton(i, { url: e.target.value })}
                placeholder="https://… or {{contactUrl}}"
                className="min-w-0 flex-1 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => removeButton(i)}
                className="text-xs text-neutral-500 hover:text-red-700 hover:underline"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <Field label="Sort order (lower first)" htmlFor="sc-sort">
        <Input
          id="sc-sort"
          type="number"
          min={0}
          max={10000}
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save channel'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
