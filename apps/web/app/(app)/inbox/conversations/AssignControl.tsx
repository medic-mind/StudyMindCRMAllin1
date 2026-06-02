// Assignee picker for the Comms Centre thread (ADR 0020 Phase 6e).
// Manager+ only — the server enforces it; we also hide the control for
// roles that can't assign by relying on assignableUsers returning FORBIDDEN
// (the query errors → we render nothing). Assigning routes through Trengo's
// assignTicket via interaction.trengo.assign.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface Props {
  conversationId: string
  contactId: string
  ticketId: number
  /** Currently-assigned CRM user id, if any. */
  assigneeUserId: string | null
}

export function AssignControl({
  conversationId,
  contactId,
  ticketId,
  assigneeUserId,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [selected, setSelected] = useState<string>(assigneeUserId ?? '')

  // Errors (e.g. FORBIDDEN for non-managers) leave `data` undefined — we then
  // render nothing, so the control only appears for roles that can assign.
  const users = trpc.interaction.trengo.assignableUsers.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  })

  const assign = trpc.interaction.trengo.assign.useMutation({
    onSuccess: () => {
      toast.success('Assigned in Trengo')
      void utils.inbox.conversations.get.invalidate({ conversationId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not assign'),
  })

  if (users.isError || !users.data || users.data.length === 0) return null

  const dirty = selected !== (assigneeUserId ?? '')

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white p-3 text-sm shadow-sm">
      <label className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Assignee
        </span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="rounded border border-neutral-300 bg-white px-2 py-1"
        >
          <option value="">Unassigned</option>
          {users.data.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!dirty || !selected || assign.isPending}
        onClick={() =>
          assign.mutate({ contactId, ticketId, assigneeUserId: selected })
        }
        className="rounded bg-primary-600 px-2.5 py-1 text-white hover:bg-primary-700 disabled:opacity-50"
      >
        {assign.isPending ? 'Assigning…' : 'Assign'}
      </button>
      <span className="text-xs text-neutral-500">syncs to Trengo</span>
    </div>
  )
}
