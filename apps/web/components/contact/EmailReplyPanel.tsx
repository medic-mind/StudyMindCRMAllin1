// Email reply panel — mounts on every email_received Interaction in the
// contact timeline. CLAUDE.md §14, §18.
//
// Lets the agent generate an AI draft (interaction.draftReply) seed, edit it,
// then send via interaction.email.reply (Gmail outbound).

'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  interactionId: string
}

export function EmailReplyPanel({ interactionId }: Props) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [includeOriginal, setIncludeOriginal] = useState(true)
  const [draftPromptVersion, setDraftPromptVersion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sentMessageId, setSentMessageId] = useState<string | null>(null)

  const draft = trpc.interaction.draftReply.useMutation({
    onSuccess: (out) => {
      setBody(out.text)
      setDraftPromptVersion(out.promptVersion)
      setError(null)
    },
    onError: (e) => setError(e.message),
  })

  const reply = trpc.interaction.email.reply.useMutation({
    onSuccess: (out) => {
      setSentMessageId(out.gmailMessageId)
      setError(null)
    },
    onError: (e) => setError(e.message),
  })

  if (!open) {
    return (
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Reply
      </Button>
    )
  }

  if (sentMessageId) {
    return (
      <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900">
        Sent. Gmail message id <span className="font-mono">{sentMessageId}</span>.
      </div>
    )
  }

  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-neutral-700">Reply</h4>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={draft.isPending}
          onClick={() =>
            draft.mutate({ interactionId, goal: 'Reply to the most recent inbound', channel: 'email' })
          }
        >
          {draft.isPending ? 'Drafting…' : 'Generate AI draft'}
        </Button>
        {draftPromptVersion && (
          <span className="text-xs text-neutral-500">
            AI draft from prompt {draftPromptVersion} — review before sending.
          </span>
        )}
      </div>

      <textarea
        aria-label="Reply body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        placeholder="Write or generate a draft, then edit before sending."
        className="mt-2 w-full rounded border border-neutral-300 bg-white p-2 font-mono text-sm"
      />

      <label className="mt-2 flex items-center gap-2 text-xs text-neutral-700">
        <input
          type="checkbox"
          checked={includeOriginal}
          onChange={(e) => setIncludeOriginal(e.target.checked)}
        />
        Include the original message as a quoted block
      </label>

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={reply.isPending || body.trim().length === 0}
          onClick={() =>
            reply.mutate({ interactionId, body: body.trim(), includeOriginal })
          }
        >
          {reply.isPending ? 'Sending…' : 'Send reply'}
        </Button>
      </div>
    </div>
  )
}
