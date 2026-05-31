// Inline reply + lifecycle actions for the Comms Centre thread view.
// ADR 0020 Phase 4. Reuses the audited outbound (interaction.trengo.reply,
// .close, .reopen) — no new server code. Virtual Assistants see the
// composer disabled per server-side FORBIDDEN; we surface the same intent
// in the UI by hiding the send button on the error toast.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface Props {
  conversationId: string
  contactId: string
  ticketId: number
  status: 'open' | 'closed' | 'snoozed' | 'archived'
  /** Channel of the conversation — filters which quick replies apply. */
  channel: string | null
  /** Contact display name — used to substitute {{first_name}} / {{name}}
   *  in a quick reply at insert time. */
  contactName: string | null
  /** Seed for the reply — we tell the server which inbound to thread
   *  against. Null when there are no messages yet (rare; we still allow
   *  the send to create the first outbound). */
  latestInteractionId: string | null
}

/** Substitute the supported placeholders with the contact's details. */
function applyPlaceholders(body: string, contactName: string | null): string {
  const name = contactName?.trim() ?? ''
  const firstName = name.split(/\s+/)[0] ?? ''
  return body
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*name\s*\}\}/gi, name)
}

export function ConversationReply({
  conversationId,
  contactId,
  ticketId,
  status,
  channel,
  contactName,
  latestInteractionId,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [body, setBody] = useState('')

  const quickReplies = trpc.quickReply.list.useQuery(
    channel ? { channel: channel as 'whatsapp' | 'sms' | 'email' | 'web_chat' } : undefined,
    { staleTime: 5 * 60_000, retry: false },
  )

  const insertQuickReply = (replyBody: string) => {
    const text = applyPlaceholders(replyBody, contactName)
    setBody((cur) => (cur.trim() ? `${cur}\n${text}` : text))
  }

  const send = trpc.interaction.trengo.reply.useMutation({
    onSuccess: () => {
      setBody('')
      toast.success('Reply sent')
      void utils.inbox.conversations.get.invalidate({ conversationId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not send reply'),
  })

  const close = trpc.interaction.trengo.close.useMutation({
    onSuccess: () => {
      toast.success('Conversation closed in Trengo')
      void utils.inbox.conversations.get.invalidate({ conversationId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not close conversation'),
  })

  const reopen = trpc.interaction.trengo.reopen.useMutation({
    onSuccess: () => {
      toast.success('Conversation reopened in Trengo')
      void utils.inbox.conversations.get.invalidate({ conversationId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not reopen conversation'),
  })

  const canSend = !!latestInteractionId
  const sendDisabled = send.isPending || !body.trim() || !canSend

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Reply
        </span>
        {(quickReplies.data?.length ?? 0) > 0 ? (
          <select
            defaultValue=""
            onChange={(e) => {
              const qr = quickReplies.data?.find((q) => q.id === e.target.value)
              if (qr) insertQuickReply(qr.body)
              e.currentTarget.value = ''
            }}
            className="max-w-[14rem] rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
            aria-label="Insert a quick reply"
          >
            <option value="" disabled>
              Quick reply…
            </option>
            {quickReplies.data!.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder={
            canSend
              ? 'Write your reply here. Sends through Trengo on the same channel.'
              : 'No inbound message to reply to yet.'
          }
          className="w-full rounded border border-neutral-300 bg-white p-2 font-mono text-sm focus:border-primary-500 focus:outline-none"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!latestInteractionId) return
            send.mutate({ interactionId: latestInteractionId, body })
          }}
          disabled={sendDisabled}
          className="rounded bg-primary-600 px-3 py-1 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
        {status === 'closed' ? (
          <button
            type="button"
            onClick={() =>
              reopen.mutate({ contactId, ticketId })
            }
            disabled={reopen.isPending}
            className="rounded border border-primary-200 bg-primary-50 px-3 py-1 text-sm text-primary-800 hover:bg-primary-100 disabled:opacity-50"
          >
            {reopen.isPending ? 'Reopening…' : 'Reopen conversation'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => close.mutate({ contactId, ticketId })}
            disabled={close.isPending}
            className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {close.isPending ? 'Closing…' : 'Close conversation'}
          </button>
        )}
        <span className="text-xs text-neutral-500">
          Send + state changes sync to Trengo.
        </span>
      </div>
    </div>
  )
}
