// One-click task completion tick. Toggles a task between done and open
// straight from a list row — no dialog. Optimistic (CLAUDE.md §26 allows it
// for the mark-done fast path); reverts and toasts on error. The server
// audits the change (task.close / task.update).

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { CheckCircleIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

export function TaskCheckbox({
  id,
  status,
  size = 20,
}: {
  id: string
  status: string
  size?: number
}) {
  const router = useRouter()
  const serverDone = status === 'done'
  const [checked, setChecked] = useState(serverDone)

  // Re-sync when the server prop changes (e.g. after router.refresh()).
  useEffect(() => setChecked(serverDone), [serverDone])

  const onError = (message: string) => {
    setChecked(serverDone) // revert optimistic flip
    toast.error(message || 'Could not update task')
  }
  const close = trpc.task.close.useMutation({
    onSuccess: () => {
      toast.success('Task completed')
      router.refresh()
    },
    onError: (e) => onError(e.message),
  })
  const reopen = trpc.task.update.useMutation({
    onSuccess: () => router.refresh(),
    onError: (e) => onError(e.message),
  })
  const pending = close.isPending || reopen.isPending

  const toggle = () => {
    if (pending) return
    const next = !checked
    setChecked(next)
    if (next) close.mutate({ id, status: 'done' })
    else reopen.mutate({ id, status: 'open' })
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={checked}
      aria-label={checked ? 'Mark task not done' : 'Mark task done'}
      className="inline-flex items-center justify-center rounded-full p-0.5 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
    >
      {checked ? (
        <CheckCircleIcon size={size} className="text-emerald-600" />
      ) : (
        <span
          aria-hidden="true"
          className="block rounded-full border-2 border-neutral-300 transition-colors hover:border-emerald-500"
          style={{ width: size - 2, height: size - 2 }}
        />
      )}
    </button>
  )
}
