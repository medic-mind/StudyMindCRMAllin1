'use client'

// Force an immediate re-pull from the camp app (the 15-min cron's on-demand
// variant), then refresh the RSC list.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { RepeatIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

export function SyncNowButton({ connected, canSync }: { connected: boolean; canSync: boolean }) {
  const router = useRouter()
  const [waiting, setWaiting] = useState(false)
  const sync = trpc.summerCamp.bookings.syncNow.useMutation({
    onSuccess: () => {
      toast.success('Sync requested — new bookings appear within a few seconds')
      setWaiting(true)
      // Give the background pull a moment, then refresh the server list.
      setTimeout(() => {
        router.refresh()
        setWaiting(false)
      }, 4000)
    },
    onError: (err) => toast.error(err.message),
  })

  if (!canSync) return null
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={!connected || sync.isPending || waiting}
      onClick={() => sync.mutate()}
      title={connected ? undefined : 'Summer Camp app not connected'}
    >
      <RepeatIcon size={14} />
      {sync.isPending || waiting ? 'Syncing…' : 'Sync from camp'}
    </Button>
  )
}
