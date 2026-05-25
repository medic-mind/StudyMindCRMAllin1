// Per-card "Move to…" dropdown. ADR 0018. No drag yet (slice 3). The parent
// RSC only renders this for roles that can call card.move; the server gates
// too (CLAUDE.md §20, §3).

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
  cardId: string
  currentStageId: string
  stages: ReadonlyArray<StageOption>
}

export function MoveCardMenu({ cardId, currentStageId, stages }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const move = trpc.card.move.useMutation({
    onSuccess: (_data, vars) => {
      const dest = stages.find((s) => s.id === vars.toStageId)
      toast.success(`Moved to ${dest?.name ?? 'new stage'}`)
      setPending(false)
      router.refresh()
    },
    onError: (e) => {
      setPending(false)
      toast.error(e.message ?? 'Could not move card')
    },
  })

  const targets = stages.filter((s) => s.id !== currentStageId)
  if (targets.length === 0) return null

  return (
    <label className="block">
      <span className="sr-only">Move card</span>
      <select
        disabled={move.isPending}
        value=""
        onChange={(e) => {
          const next = e.target.value
          if (!next) return
          setPending(true)
          move.mutate({ cardId, toStageId: next })
        }}
        className="w-full rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
        aria-label="Move card to another stage"
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
