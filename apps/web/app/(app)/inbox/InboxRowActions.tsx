// Per-row inbox actions: Assign to me, Snooze. CLAUDE.md §11, §27.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  interactionId: string
  contactId: string | null
}

export function InboxRowActions({ interactionId, contactId }: Props) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const me = trpc.account.me.useQuery(undefined)
  const assign = trpc.inbox.assign.useMutation({
    onSuccess: () => {
      setDone('Assigned to you')
      toast.success('Assigned to you')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not assign')
    },
  })
  const snooze = trpc.inbox.snooze.useMutation({
    onSuccess: () => {
      setDone('Snoozed 1h')
      toast.success('Snoozed for 1 hour')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not snooze')
    },
  })

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.preventDefault()}>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={assign.isPending || !me.data?.id}
        onClick={() => {
          if (me.data?.id) assign.mutate({ interactionId, assigneeId: me.data.id })
        }}
      >
        Assign to me
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={snooze.isPending}
        onClick={() => snooze.mutate({ interactionId, minutes: 60 })}
      >
        Snooze 1h
      </Button>
      {contactId ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            // Anchor on the inline EmailReplyPanel inside the contact page.
            window.location.href = `/contacts/${contactId}#reply`
          }}
        >
          Reply
        </Button>
      ) : null}
      {done && (
        <span role="status" className="text-xs text-neutral-500">
          {done}
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </div>
  )
}
