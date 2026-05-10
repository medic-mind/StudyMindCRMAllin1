// Pipeline transition control. CLAUDE.md §6.4 — transitions are explicit and
// audited; we wrap the action in an inline confirm dialog so the agent
// confirms intent before the audit row is written.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

type FamilyState = 'lead' | 'trial' | 'active' | 'at_risk' | 'churned'

const STATES: ReadonlyArray<{ key: FamilyState; label: string }> = [
  { key: 'lead', label: 'Lead' },
  { key: 'trial', label: 'Trial' },
  { key: 'active', label: 'Active' },
  { key: 'at_risk', label: 'At risk' },
  { key: 'churned', label: 'Churned' },
]

interface Props {
  familyId: string
  currentState: FamilyState
}

export function PipelineTransitionMenu({ familyId, currentState }: Props) {
  const router = useRouter()
  const [target, setTarget] = useState<FamilyState | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const transition = trpc.family.pipeline.transition.useMutation({
    onSuccess: (_data, vars) => {
      setTarget(null)
      setReason('')
      setError(null)
      toast.success(`Family moved to ${vars.toState.replace('_', ' ')}`)
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not move family')
    },
  })

  if (target) {
    return (
      <div
        role="alertdialog"
        aria-label="Confirm pipeline transition"
        className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs"
      >
        <p className="text-neutral-800">
          Move from <span className="font-mono">{currentState}</span> to{' '}
          <span className="font-mono">{target}</span>? This writes a
          family.state_changed Interaction.
        </p>
        <textarea
          required
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why? (audited reason, 3+ chars)"
          className="mt-2 w-full rounded border border-neutral-300 bg-white p-1 text-xs"
        />
        {error && (
          <p role="alert" className="mt-1 text-red-700">
            {error}
          </p>
        )}
        <div className="mt-2 flex gap-1.5">
          <Button
            type="button"
            size="sm"
            disabled={transition.isPending || reason.trim().length < 3}
            onClick={() =>
              transition.mutate({
                familyId,
                toState: target,
                reason: reason.trim(),
              })
            }
          >
            {transition.isPending ? 'Moving…' : 'Confirm'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setTarget(null)
              setError(null)
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {STATES.filter((s) => s.key !== currentState).map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => setTarget(s.key)}
          className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[10px] text-neutral-700 hover:bg-neutral-100"
        >
          → {s.label}
        </button>
      ))}
    </div>
  )
}
