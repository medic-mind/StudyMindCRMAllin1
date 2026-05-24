// Per-card "Move to..." dropdown. ADR 0015. CLAUDE.md §3 (no drag — humans
// confirm), §26 (client leaves), §20 (UI hides what the user cannot do —
// the parent server component decides whether to render this widget).

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface StageOption {
  id: string
  name: string
}

interface Props {
  familyId: string
  currentStageId: string
  stages: ReadonlyArray<StageOption>
}

export function MoveStageMenu({ familyId, currentStageId, stages }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const move = trpc.pipeline.family.move.useMutation({
    onSuccess: (_data, vars) => {
      const dest = stages.find((s) => s.id === vars.stageId)
      toast.success(`Moved to ${dest?.name ?? 'new stage'}`)
      setPending(null)
      router.refresh()
    },
    onError: (e) => {
      setPending(null)
      toast.error(e.message ?? 'Could not move family')
    },
  })

  const targets = stages.filter((s) => s.id !== currentStageId)
  if (targets.length === 0) return null

  return (
    <label className="block">
      <span className="sr-only">Move family</span>
      <select
        disabled={move.isPending}
        value=""
        onChange={(e) => {
          const next = e.target.value
          if (!next) return
          setPending(next)
          move.mutate({ familyId, stageId: next })
        }}
        className="w-full rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
        aria-label="Move family to another stage"
      >
        <option value="">{pending ? 'Moving…' : 'Move to…'}</option>
        {targets.map((s) => (
          <option key={s.id} value={s.id}>
            → {s.name}
          </option>
        ))}
      </select>
    </label>
  )
}
