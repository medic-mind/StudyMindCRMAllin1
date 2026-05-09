'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function FlagToggle({ name, enabled }: { name: string; enabled: boolean }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const m = trpc.admin.flags.setFlag.useMutation({
    onSuccess: () => {
      setPending(false)
      router.refresh()
    },
    onError: (e) => {
      setPending(false)
      setError(e.message)
    },
  })

  return (
    <div>
      <Button
        type="button"
        variant={enabled ? 'destructive' : 'default'}
        disabled={pending}
        onClick={() => {
          const reason = window.prompt(
            `Reason for turning ${name} ${enabled ? 'OFF' : 'ON'}?`,
          )
          if (!reason || reason.trim().length < 3) return
          setError(null)
          setPending(true)
          m.mutate({ name, enabled: !enabled, reason })
        }}
        className="h-7 px-2 text-xs"
      >
        {enabled ? 'Turn off' : 'Turn on'}
      </Button>
      {error ? (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
