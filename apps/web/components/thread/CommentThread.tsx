// Shared comment thread. Renders a list of comments (author + relative time +
// body) and a composer. The parent owns the data + the add-mutation, so this
// component is reused by both cards (slice A) and tasks (slice B).
//
// Optimistic append: on submit we render the new comment immediately, then
// reconcile against the server result via the parent's onAdd promise. CLAUDE.md
// §26 (mutations go through tRPC, optimistic allowed for non-money paths).

'use client'

import { useRef, useState } from 'react'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/lib/format/relative-time'

import type { ThreadComment } from './comment-types'

interface Props {
  comments: ReadonlyArray<ThreadComment>
  /** Resolves once the comment is persisted. Throwing surfaces an error. */
  onAdd: (body: string) => Promise<void>
  currentUserName: string
  canComment: boolean
}

interface PendingComment extends ThreadComment {
  pending: true
}

export function CommentThread({ comments, onAdd, currentUserName, canComment }: Props) {
  const [body, setBody] = useState('')
  const [optimistic, setOptimistic] = useState<PendingComment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const now = new Date()

  // Server comments win; optimistic entries are only those not yet reflected.
  const merged: Array<ThreadComment & { pending?: boolean }> = [...comments, ...optimistic]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = body.trim()
    if (trimmed.length === 0 || submitting) return
    setError(null)
    setSubmitting(true)
    const localId = `optimistic_${++seq.current}`
    setOptimistic((prev) => [
      ...prev,
      {
        id: localId,
        body: trimmed,
        authorId: null,
        authorName: currentUserName,
        occurredAt: new Date(),
        pending: true,
      },
    ])
    setBody('')
    try {
      await onAdd(trimmed)
      // Parent will refetch and the server copy replaces ours; drop the
      // placeholder so we never double-render.
      setOptimistic((prev) => prev.filter((c) => c.id !== localId))
    } catch (err) {
      setOptimistic((prev) => prev.filter((c) => c.id !== localId))
      setBody(trimmed)
      setError(err instanceof Error ? err.message : 'Could not post comment')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {merged.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No comments yet — add the first note. Comments are saved to the contact&apos;s history.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {merged.map((c) => (
            <li key={c.id} className="flex gap-2">
              <Avatar name={c.authorName ?? 'Unknown'} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-neutral-900">
                    {c.authorName ?? 'Unknown'}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-neutral-500">
                    {formatRelativeTime(new Date(c.occurredAt), now)}
                  </span>
                  {'pending' in c && c.pending ? (
                    <span className="text-[10px] text-neutral-400">Sending…</span>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-neutral-700">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canComment ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label className="sr-only" htmlFor="comment-composer">
            Add a comment
          </label>
          <textarea
            id="comment-composer"
            rows={3}
            value={body}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a comment… (saved to the contact history)"
            className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
          />
          {error ? (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={submitting || body.trim().length === 0}>
              {submitting ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-neutral-500">You do not have permission to comment.</p>
      )}
    </div>
  )
}
