'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { trpc } from '@/lib/trpc/client'

type TriageAction =
  | 'acknowledge'
  | 'request_info'
  | 'escalate_restricted'
  | 'refer_la'
  | 'refer_mash'
  | 'close_resolved'

const ACTIONS: { id: TriageAction; label: string }[] = [
  { id: 'acknowledge', label: 'Acknowledge' },
  { id: 'request_info', label: 'Request more info' },
  { id: 'escalate_restricted', label: 'Escalate to restricted_access' },
  { id: 'refer_la', label: 'Refer to LA' },
  { id: 'refer_mash', label: 'Refer to MASH' },
  { id: 'close_resolved', label: 'Close as resolved' },
]

export function TriageDialogTrigger({ flagId }: { flagId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<TriageAction>('acknowledge')
  const [rationale, setRationale] = useState('')
  const triage = trpc.safeguarding.triage.useMutation({
    onSuccess: () => {
      toast.success('Action recorded.')
      setOpen(false)
      setRationale('')
      router.refresh()
    },
    onError: (err) => toast.error(err.message ?? 'Action failed'),
  })

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Triage
      </Button>
    )
  }
  return (
    <div className="space-y-3 rounded-md border border-neutral-300 bg-white p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`action-${flagId}`}>Action</Label>
        <select
          id={`action-${flagId}`}
          className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
          value={action}
          onChange={(e) => setAction(e.target.value as TriageAction)}
        >
          {ACTIONS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`rationale-${flagId}`}>Rationale (audited)</Label>
        <Textarea
          id={`rationale-${flagId}`}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={3}
          maxLength={2000}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={triage.isPending || !rationale.trim()}
          onClick={() => triage.mutate({ flagId, action, rationale: rationale.trim() })}
        >
          {triage.isPending ? 'Recording…' : 'Record'}
        </Button>
      </div>
    </div>
  )
}
