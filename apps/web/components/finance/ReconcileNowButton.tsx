// Manual reconcile button for the Family detail page. CLAUDE.md §6.3, §17.
// Same engine as the nightly job; surfaces the count of new discrepancies.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function ReconcileNowButton({ familyId }: { familyId: string }) {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const reconcile = trpc.family.reconcile.useMutation({
    onSuccess: (out) => {
      const summary = `Reconciled. ${out.created} new discrepanc${out.created === 1 ? 'y' : 'ies'} of ${out.discrepancies} total.`
      setMessage(summary)
      toast.success(summary)
      router.refresh()
    },
    onError: (e) => {
      setMessage(`Failed: ${e.message}`)
      toast.error(e.message ?? 'Reconciliation failed')
    },
  })

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={reconcile.isPending}
        onClick={() => reconcile.mutate({ familyId })}
      >
        {reconcile.isPending ? 'Reconciling…' : 'Reconcile now'}
      </Button>
      {message ? (
        <span role="status" className="text-xs text-neutral-600">
          {message}
        </span>
      ) : null}
    </div>
  )
}
