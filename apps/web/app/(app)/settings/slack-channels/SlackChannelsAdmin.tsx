// CRUD admin for Slack channel options. The primary add path is a pick-by-name
// browser over the workspace's channels (slackChannel.discover — needs the
// channels:read bot scope, falls back gracefully); manual id entry stays as
// the fallback and the only way in for private channels. Each row has a
// "Send test" so the operator can verify the bot can actually post (token +
// /invite) before a real notification needs it. Manager+ via the tRPC layer.
// CLAUDE.md §10/§12.

'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
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
  const [picking, setPicking] = useState(false)

  const channels = listQuery.data ?? []

  async function refresh() {
    await listQuery.refetch()
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-neutral-600">
          These are the channels the CRM can post into — call summaries, alerts, and
          the routed notifications below. Add a channel by picking it from your Slack
          workspace, then use <strong>Send test</strong> to confirm the bot can post
          there. The <strong>default</strong> channel is used when nothing more
          specific is configured.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {!picking && (
            <Button type="button" size="sm" onClick={() => { setPicking(true); setCreating(false) }}>
              Add from Slack
            </Button>
          )}
          {!creating && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => { setCreating(true); setPicking(false) }}
            >
              Enter id manually
            </Button>
          )}
        </div>
      </div>

      {picking && (
        <SlackChannelPicker
          existing={channels}
          onClose={() => setPicking(false)}
          onAdded={refresh}
        />
      )}

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

/**
 * Pick-by-name browser over the workspace's public channels. One click adds a
 * channel with a sensible label — no hunting for C012… ids. Private channels
 * cannot be listed (Slack needs an extra permission for that) so the manual
 * id form remains the path for those.
 */
function SlackChannelPicker({
  existing,
  onClose,
  onAdded,
}: {
  existing: ChannelOption[]
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const discover = trpc.slackChannel.discover.useQuery(undefined, {
    refetchOnWindowFocus: false,
  })
  const create = trpc.slackChannel.create.useMutation()
  const [query, setQuery] = useState('')
  const [addingId, setAddingId] = useState<string | null>(null)

  const knownIds = useMemo(() => new Set(existing.map((c) => c.channelId)), [existing])

  const rows = useMemo(() => {
    const all = discover.data?.status === 'ok' ? discover.data.channels : []
    const q = query.trim().toLowerCase()
    return q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all
  }, [discover.data, query])

  async function add(channel: { id: string; name: string }) {
    setAddingId(channel.id)
    try {
      await create.mutateAsync({
        label: `#${channel.name}`,
        channelId: channel.id,
        isDefault: existing.filter((c) => !c.archived).length === 0,
        actionButtons: [{ label: 'Open in CRM', url: '{{contactUrl}}' }],
        sortOrder: 100,
      })
      toast.success(`#${channel.name} added — use "Send test" to confirm the bot can post.`)
      await onAdded()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add channel')
    } finally {
      setAddingId(null)
    }
  }

  const status = discover.isLoading ? 'loading' : (discover.data?.status ?? 'error')

  return (
    <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-900">Add a channel from Slack</h3>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void discover.refetch()}
            disabled={discover.isFetching}
            className="text-xs font-medium text-primary-700 hover:underline disabled:opacity-50"
          >
            {discover.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" onClick={onClose} className="text-xs text-neutral-500 hover:underline">
            Close
          </button>
        </div>
      </div>

      {status === 'loading' && (
        <p className="text-sm text-neutral-500">Loading your Slack channels…</p>
      )}

      {status === 'not_configured' && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Slack isn&apos;t connected yet — set up the bot under{' '}
          <Link href="/settings/integrations/slack" className="font-medium underline">
            Settings → Integrations → Slack
          </Link>{' '}
          first. You can still add a channel by id with &quot;Enter id manually&quot;.
        </p>
      )}

      {status === 'missing_scope' && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The Slack app can&apos;t list channels yet. In{' '}
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline"
          >
            api.slack.com/apps
          </a>{' '}
          add the <code className="rounded bg-amber-100 px-1">channels:read</code> bot
          permission and re-install the app to your workspace — then this picker lists every
          channel by name. Until then, add channels by id with &quot;Enter id manually&quot;.
        </p>
      )}

      {status === 'error' && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Couldn&apos;t reach Slack just now
          {discover.data?.status === 'error' && discover.data.message
            ? ` (${discover.data.message})`
            : ''}
          . Try again in a minute, or add the channel by id manually.
        </p>
      )}

      {status === 'ok' && (
        <>
          {discover.data?.status === 'ok' && discover.data.botName ? (
            <p className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-600">
              The CRM&apos;s token is{' '}
              <span className="font-semibold text-neutral-900">@{discover.data.botName}</span>
              {discover.data.teamName ? <> in <span className="font-medium">{discover.data.teamName}</span></> : null}
              . If a channel shows &quot;Bot not invited&quot; after you invited a bot, make
              sure it was <span className="font-semibold">exactly @{discover.data.botName}</span>{' '}
              — inviting a different app doesn&apos;t count. After inviting, hit Refresh.
            </p>
          ) : null}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search channels…"
            aria-label="Search Slack channels"
            autoFocus
          />
          {rows.length === 0 ? (
            <p className="text-sm text-neutral-500">
              {query ? 'No channels match that search.' : 'No public channels found.'}
            </p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {rows.map((c) => {
                const added = c.alreadyAdded || knownIds.has(c.id)
                return (
                  <li
                    key={c.id}
                    className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">
                      #{c.name}
                      {c.isPrivate ? (
                        <span className="ml-1.5 rounded bg-neutral-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-neutral-500">
                          Private
                        </span>
                      ) : null}
                    </span>
                    {!c.isMember && (
                      <span
                        className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
                        title={`The bot has not been invited to this channel yet — posts will fail until you type /invite @${
                          discover.data?.status === 'ok' && discover.data.botName
                            ? discover.data.botName
                            : 'YourBot'
                        } in it. Invited it already? Make sure it was that exact app, then hit Refresh.`}
                      >
                        Bot not invited
                      </span>
                    )}
                    {added ? (
                      <span className="shrink-0 text-xs text-neutral-400">Added</span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={addingId === c.id}
                        onClick={() => add(c)}
                      >
                        {addingId === c.id ? 'Adding…' : 'Add'}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="text-[11px] text-neutral-500">
            Private channels list here once the Slack app has the{' '}
            <code className="rounded bg-neutral-100 px-1">groups:read</code> scope and the
            bot is invited; otherwise add them by id with &quot;Enter id manually&quot;.
          </p>
        </>
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
  const testPost = trpc.slackChannel.testPost.useMutation()
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)

  async function sendTest() {
    setTesting(true)
    try {
      const res = await testPost.mutateAsync({ id: channel.id })
      if (res.ok) {
        toast.success(`Test posted to ${channel.label} — check Slack.`)
      } else {
        toast.error(res.reason, { duration: 9000 })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the test')
    } finally {
      setTesting(false)
    }
  }

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
        <div className="flex items-center gap-2">
          {!channel.archived && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={sendTest}
              disabled={testing}
              title="Post a test message so you can confirm the bot is invited and the id is right"
            >
              {testing ? 'Sending…' : 'Send test'}
            </Button>
          )}
          <Button type="button" size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
        </div>
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
