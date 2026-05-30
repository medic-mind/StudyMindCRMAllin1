// Per-conversation action buttons for the contact Trengo section.
// Client island so the Close / Reopen mutations can run from the agent's
// browser. Stays purely additive — no state of its own beyond the in-flight
// flag. Surfaced under each conversation card; never visible to Virtual
// Assistants because the server rejects with FORBIDDEN.

'use client'

import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
  /** Conversation id from the view-model. Numeric Trengo ticket ids parse to
   *  a number; synthetic ids (e.g. `single:foo`) skip rendering. */
  conversationId: string
  /** Current derived ticket status from the view-model. */
  ticketStatus: string | null
}

export function TrengoConversationActions({
  contactId,
  conversationId,
  ticketStatus,
}: Props): JSX.Element | null {
  // Synthetic ids cannot be acted on — they have no Trengo ticket behind them.
  const ticketId = Number(conversationId)
  if (!Number.isInteger(ticketId) || ticketId <= 0) return null

  const utils = trpc.useUtils()
  const close = trpc.interaction.trengo.close.useMutation({
    onSuccess: () => {
      toast.success('Conversation closed in Trengo')
      // Refresh the conversation list so the new status shows.
      void utils.contact.channels.trengoConversations.invalidate({ contactId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not close conversation'),
  })
  const reopen = trpc.interaction.trengo.reopen.useMutation({
    onSuccess: () => {
      toast.success('Conversation reopened in Trengo')
      void utils.contact.channels.trengoConversations.invalidate({ contactId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not reopen conversation'),
  })

  const isClosed = ticketStatus === 'closed'
  const pending = close.isPending || reopen.isPending

  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      {isClosed ? (
        <button
          type="button"
          onClick={() => reopen.mutate({ contactId, ticketId })}
          disabled={pending}
          className="rounded border border-primary-200 bg-primary-50 px-2 py-0.5 text-primary-800 hover:bg-primary-100 disabled:opacity-50"
        >
          {reopen.isPending ? 'Reopening…' : 'Reopen conversation'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => close.mutate({ contactId, ticketId })}
          disabled={pending}
          className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {close.isPending ? 'Closing…' : 'Close conversation'}
        </button>
      )}
      <span className="text-neutral-400">·</span>
      <span className="text-neutral-500">syncs to Trengo</span>
    </div>
  )
}
