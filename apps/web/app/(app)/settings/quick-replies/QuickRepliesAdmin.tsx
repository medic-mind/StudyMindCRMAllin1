// Quick-replies management (Manager+). Create / edit / archive canned
// responses. ADR 0020 Phase 6h.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

type Channel = 'whatsapp' | 'sms' | 'email' | 'web_chat'

const CHANNEL_LABEL: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  web_chat: 'Web chat',
}

interface Editing {
  id: string | null
  title: string
  body: string
  channel: Channel | ''
}

const EMPTY: Editing = { id: null, title: '', body: '', channel: '' }

export function QuickRepliesAdmin() {
  const utils = trpc.useUtils()
  const list = trpc.quickReply.list.useQuery({ includeArchived: true })
  const [editing, setEditing] = useState<Editing | null>(null)

  const invalidate = () => {
    void utils.quickReply.list.invalidate()
  }

  const create = trpc.quickReply.create.useMutation({
    onSuccess: () => {
      toast.success('Quick reply created')
      setEditing(null)
      invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const update = trpc.quickReply.update.useMutation({
    onSuccess: () => {
      toast.success('Saved')
      setEditing(null)
      invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const archive = trpc.quickReply.archive.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  })

  const items = list.data ?? []

  const submit = () => {
    if (!editing) return
    if (!editing.title.trim() || !editing.body.trim()) {
      toast.error('Title and body are required')
      return
    }
    const payload = {
      title: editing.title.trim(),
      body: editing.body.trim(),
      channel: editing.channel || null,
    }
    if (editing.id) update.mutate({ id: editing.id, ...payload })
    else create.mutate(payload)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-600">
          {items.filter((i) => !i.archivedAt).length} active quick repl
          {items.filter((i) => !i.archivedAt).length === 1 ? 'y' : 'ies'}
        </p>
        {!editing ? (
          <Button type="button" onClick={() => setEditing({ ...EMPTY })}>
            New quick reply
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-600">Title</span>
              <Input
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="e.g. Booking confirmation"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-600">Channel</span>
              <select
                value={editing.channel}
                onChange={(e) =>
                  setEditing({ ...editing, channel: e.target.value as Channel | '' })
                }
                className="rounded border border-neutral-300 bg-white px-2 py-2 text-sm"
              >
                <option value="">All channels</option>
                {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-neutral-600">
              Body — {'{{first_name}}'} / {'{{name}}'} are substituted on insert
            </span>
            <textarea
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              rows={4}
              className="w-full rounded border border-neutral-300 bg-white p-2 text-sm focus:border-primary-500 focus:outline-none"
              placeholder="Hi {{first_name}}, thanks for getting in touch…"
            />
          </label>
          <div className="flex gap-2">
            <Button type="button" onClick={submit} disabled={create.isPending || update.isPending}>
              {editing.id ? 'Save' : 'Create'}
            </Button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="text-sm text-neutral-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
        {items.length === 0 ? (
          <p className="p-6 text-sm text-neutral-600">
            No quick replies yet. Create one — agents will see it in the reply
            composer on every conversation.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((q) => (
              <li
                key={q.id}
                className={q.archivedAt ? 'p-3 opacity-60' : 'p-3'}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-neutral-900">{q.title}</span>
                      {q.channel ? (
                        <Badge tone="neutral">
                          {CHANNEL_LABEL[q.channel as Channel] ?? q.channel}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">All channels</Badge>
                      )}
                      {q.archivedAt ? <Badge tone="warn">Archived</Badge> : null}
                    </div>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-neutral-600">
                      {q.body}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 text-sm">
                    {!q.archivedAt ? (
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({
                            id: q.id,
                            title: q.title,
                            body: q.body,
                            channel: (q.channel as Channel | null) ?? '',
                          })
                        }
                        className="text-primary-700 hover:underline"
                      >
                        Edit
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        archive.mutate({ id: q.id, restore: Boolean(q.archivedAt) })
                      }
                      className="text-neutral-500 hover:underline"
                    >
                      {q.archivedAt ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
