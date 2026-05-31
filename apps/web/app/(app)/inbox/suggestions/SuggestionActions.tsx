// Accept / Reject buttons for the suggestions queue. Client island so the
// mutations can run from the browser. ADR 0020 Phase 6c. CLAUDE.md §3 —
// every accept is a deliberate human action; the server enforces RBAC
// (Manager+) so a non-admin pressing the button gets FORBIDDEN.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

export function SuggestionActions({
  suggestionId,
}: {
  suggestionId: string
}) {
  const router = useRouter()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  const utils = trpc.useUtils()
  const accept = trpc.contactSuggestion.accept.useMutation({
    onSuccess: () => {
      toast.success('Applied to contact')
      void utils.contactSuggestion.list.invalidate()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not accept'),
  })
  const reject = trpc.contactSuggestion.reject.useMutation({
    onSuccess: () => {
      toast.success('Rejected')
      void utils.contactSuggestion.list.invalidate()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not reject'),
  })

  if (rejecting) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={() =>
            reject.mutate({ id: suggestionId, reason: reason.trim() || undefined })
          }
          disabled={reject.isPending}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {reject.isPending ? 'Rejecting…' : 'Confirm reject'}
        </button>
        <button
          type="button"
          onClick={() => setRejecting(false)}
          disabled={reject.isPending}
          className="text-xs text-neutral-500 hover:underline"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => accept.mutate({ id: suggestionId })}
        disabled={accept.isPending}
        className="rounded bg-primary-600 px-2.5 py-1 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
      >
        {accept.isPending ? 'Applying…' : 'Accept'}
      </button>
      <button
        type="button"
        onClick={() => setRejecting(true)}
        className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-sm text-neutral-700 hover:bg-neutral-50"
      >
        Reject
      </button>
    </div>
  )
}
