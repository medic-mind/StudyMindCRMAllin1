'use client'

// Internal notes + @mentions on a conversation (ADR 0021 Phase 6). Staff-only —
// never sent to the customer. Mentioning a teammate notifies them. All staff
// may add notes (§20). CLAUDE.md §11, §20, §26.

import { useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { XIcon } from '@/components/ui/icon'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

export function ConversationNotes({ conversationId }: { conversationId: string }) {
  const notes = trpc.inbox.conversations.notes.list.useQuery({ conversationId })
  const users = trpc.task.assignableUsers.useQuery({})
  const add = trpc.inbox.conversations.notes.add.useMutation()
  const [body, setBody] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [picking, setPicking] = useState('')

  const now = new Date()
  const userName = (id: string) => {
    const u = (users.data ?? []).find((x) => x.id === id)
    return u ? (u.name ?? u.email) : id
  }

  async function submit() {
    const trimmed = body.trim()
    if (!trimmed) return
    try {
      await add.mutateAsync({
        conversationId,
        body: trimmed,
        mentionUserIds: mentions.length ? mentions : undefined,
      })
      setBody('')
      setMentions([])
      await notes.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the note')
    }
  }

  const eligible = (users.data ?? []).filter((u) => !mentions.includes(u.id))
  const items = notes.data ?? []

  return (
    <section className="mt-6 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
        Internal notes
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium normal-case text-amber-700">
          Only your team sees this
        </span>
      </h2>

      {items.length > 0 ? (
        <ul className="mb-3 space-y-2">
          {items.map((n) => (
            <li key={n.id} className="rounded-md border border-amber-200 bg-white p-2.5">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500">
                <Avatar name={n.authorName ?? '?'} size={18} />
                <span className="font-medium text-neutral-700">
                  {n.authorName ?? 'Someone'}
                </span>
                <time dateTime={n.occurredAt.toISOString()}>
                  {formatRelativeTime(n.occurredAt, now)}
                </time>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-neutral-900">
                {n.body}
              </p>
              {n.mentions.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {n.mentions.map((m) => (
                    <span
                      key={m}
                      className="rounded-full bg-primary-50 px-1.5 py-0.5 text-[10px] text-primary-700"
                    >
                      @{userName(m)}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-neutral-500">
          No notes yet. Add context for your team — it stays internal.
        </p>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        placeholder="Add an internal note…"
        aria-label="Internal note"
        className="w-full resize-y rounded-md border border-amber-200 bg-white px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-200"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {mentions.map((m) => (
          <span
            key={m}
            className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2 py-0.5 text-xs text-primary-700"
          >
            @{userName(m)}
            <button
              type="button"
              onClick={() => setMentions((cur) => cur.filter((x) => x !== m))}
              aria-label={`Remove ${userName(m)}`}
            >
              <XIcon size={11} />
            </button>
          </span>
        ))}
        <Select
          value={picking}
          onChange={(e) => {
            const id = e.target.value
            if (id) setMentions((cur) => [...cur, id])
            setPicking('')
          }}
          className="h-8 max-w-[180px] text-xs"
        >
          <option value="">Notify…</option>
          {eligible.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name ?? u.email}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          size="sm"
          disabled={add.isPending || !body.trim()}
          onClick={submit}
          className="ml-auto"
        >
          {add.isPending ? 'Adding…' : 'Add note'}
        </Button>
      </div>
    </section>
  )
}
