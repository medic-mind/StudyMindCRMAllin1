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
  /** Currently-assigned Trengo agent id, if any. */
  trengoAssigneeId: number | null
}

export function AssignControl({
  conversationId,
  contactId,
  ticketId,
  trengoAssigneeId,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [selected, setSelected] = useState<string>(
    trengoAssigneeId != null ? String(trengoAssigneeId) : '',
  )

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

  // Surface a "sync the team" hint when the picker is empty for a manager —
  // the mirror hasn't been populated yet (Settings → Integrations → Trengo).
  if (users.isError) return null
  if (!users.data || users.data.length === 0) {
    return (
      <div className="mb-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-500">
        No Trengo agents synced yet. Sync the team on Settings → Integrations →
        Trengo, then assign here.
      </div>
    )
  }

  const dirty = selected !== (trengoAssigneeId != null ? String(trengoAssigneeId) : '')

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
            <option key={u.trengoUserId} value={String(u.trengoUserId)}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!dirty || !selected || assign.isPending}
        onClick={() =>
          assign.mutate({ contactId, ticketId, trengoUserId: Number(selected) })
        }
        className="rounded bg-primary-600 px-2.5 py-1 text-white hover:bg-primary-700 disabled:opacity-50"
      >
        {assign.isPending ? 'Assigning…' : 'Assign'}
      </button>
      <span className="text-xs text-neutral-500">syncs to Trengo</span>
    </div>
  )
}
