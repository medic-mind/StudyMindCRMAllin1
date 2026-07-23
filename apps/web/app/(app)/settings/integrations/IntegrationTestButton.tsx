// Per-provider "Test webhook" button on the Settings → Integrations page.
// Inserts a synthetic ProviderEvent so the dashboard's last-event timestamp
// updates and the round-trip through the audit log can be confirmed.
// CLAUDE.md §11, §13, §14, §25.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

type Provider =
  | 'gocardless'
  | 'aircall'
  | 'trengo'
  | 'slack'
  | 'gmail'
  | 'booking'
  | 'lead'

export function IntegrationTestButton({ provider }: { provider: Provider }) {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const test = trpc.admin.integrations.test.useMutation({
    onSuccess: (out) => {
      setMessage(`OK · ${out.eventId}`)
      toast.success(`${provider} test event accepted`)
      router.refresh()
    },
    onError: (e) => {
      setMessage(`Failed: ${e.message}`)
      toast.error(e.message ?? `${provider} test failed`)
    },
  })
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={test.isPending}
        onClick={() => test.mutate({ provider })}
      >
        {test.isPending ? 'Testing…' : 'Test webhook'}
      </Button>
      {message && (
        <span className="font-mono text-[10px] text-neutral-500">{message}</span>
      )}
    </div>
  )
}
