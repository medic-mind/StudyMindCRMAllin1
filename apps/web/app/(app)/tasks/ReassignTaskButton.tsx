// Reassign-task per-row action. Calls task.update with a new assigneeId.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function ReassignTaskButton({
  taskId,
  currentAssigneeId,
}: {
  taskId: string
  currentAssigneeId: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [assigneeId, setAssigneeId] = useState(currentAssigneeId ?? '')
  const [error, setError] = useState<string | null>(null)
  const usersQuery = trpc.task.assignableUsers.useQuery({}, { enabled: open })
  const update = trpc.task.update.useMutation({
    onSuccess: () => {
      setOpen(false)
      router.refresh()
    },
    onError: (e) => setError(e.message),
  })

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
      >
        Reassign
      </Button>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <select
        value={assigneeId}
        onChange={(e) => setAssigneeId(e.target.value)}
        className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
      >
        <option value="">Select…</option>
        {(usersQuery.data ?? []).map((u) => (
          <option key={u.id} value={u.id}>
            {u.name ? `${u.name} (${u.email})` : u.email}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="sm"
        disabled={update.isPending || !assigneeId}
        onClick={() => update.mutate({ id: taskId, assigneeId })}
      >
        {update.isPending ? 'Saving…' : 'Save'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </div>
  )
}
