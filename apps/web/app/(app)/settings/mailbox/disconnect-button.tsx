'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { trpc } from '@/lib/trpc/client'

export function DisconnectGmailButton(): React.ReactNode {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const disconnect = trpc.oauth.gmail.disconnect.useMutation({
    onSuccess: () => {
      router.refresh()
    },
    onError: (e) => setError(e.message),
  })

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (
            confirm(
              'Disconnect Gmail? This revokes our access at Google and stops background sync. You can reconnect at any time.',
            )
          ) {
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
