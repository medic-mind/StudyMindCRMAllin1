'use client'

// Move-state confirmation button. CLAUDE.md §3 (humans confirm — no
// auto-merge, no auto-charge, no silent state hops). Calls
// tender.transition via tRPC and refreshes the page on success.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { trpc } from '@/lib/trpc/client'

export interface TenderMoveButtonProps {
  tenderId: string
  from: string
  to: string
  label: string
}

export function TenderMoveButton(props: TenderMoveButtonProps) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const transition = trpc.tender.transition.useMutation({
    onSuccess: () => {
      setPending(false)
      router.refresh()
    },
    onError: (err) => {
      setPending(false)
      setError(err.message)
    },
  })

  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          const confirmed = window.confirm(
            `Move tender from ${props.from} to ${props.to}? This is logged and notifies #crm-tenders.`,
          )
          if (!confirmed) return
          setError(null)
          setPending(true)
          transition.mutate({ tenderId: props.tenderId, to: props.to as never })
        }}
        className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
      >
        → {props.label}
      </button>
      {error ? (
        <span className="mt-1 text-[10px] text-rose-700" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  )
}
