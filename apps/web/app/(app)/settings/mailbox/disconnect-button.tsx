'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { useConfirm } from '@/components/ui/confirm'
import { trpc } from '@/lib/trpc/client'

export function DisconnectGmailButton(): React.ReactNode {
  const router = useRouter()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const disconnect = trpc.oauth.gmail.disconnect.useMutation({
    onSuccess: () => {
      toast.success('Mailbox disconnected')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not disconnect mailbox')
    },
  })

  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          const ok = await confirm({
            title: 'Disconnect Gmail?',
            body: 'This revokes our access at Google and stops background sync. You can reconnect at any time.',
            confirmLabel: 'Disconnect',
            tone: 'danger',
          })
          if (ok) {
            setError(null)
            disconnect.mutate()
          }
        }}
        disabled={disconnect.isPending}
        className="inline-flex items-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
      >
        {disconnect.isPending ? 'Disconnecting…' : 'Disconnect mailbox'}
      </button>
      {error ? (
        <div className="mt-2 text-sm text-red-700">{error}</div>
      ) : null}
    </div>
  )
}
