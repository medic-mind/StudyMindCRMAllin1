'use client'

// Shared period (from/to) form across the report pages.
//
// Why a client component (it used to be a native `method="GET"` form):
//   1. Uncontrolled `defaultValue` date inputs go STALE on soft navigation.
//      When you click a preset chip / direction / provider filter, Next.js does
//      a soft navigation and React REUSES the existing <input> element — it does
//      not reset an uncontrolled input to the new `defaultValue`. The boxes then
//      lie about the active period (the "Last 90 days highlighted but the dates
//      say 11 May–11 June" bug). Controlling `value` + re-syncing from props on
//      navigation keeps them honest.
//   2. A native GET form submits ONLY its own fields, so updating the dates
//      wiped any active `direction` / `provider` / `view` filter from the URL.
//      We now merge into the existing query string instead of replacing it.

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function PeriodForm({ fromIso, toIso }: { fromIso: string; toIso: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [from, setFrom] = useState(fromIso)
  const [to, setTo] = useState(toIso)

  // Re-sync whenever the active period changes via the URL (preset chip, a
  // browser back/forward, …) so the inputs always reflect what is actually
  // being shown. Without this the uncontrolled-input staleness returns.
  useEffect(() => setFrom(fromIso), [fromIso])
  useEffect(() => setTo(toIso), [toIso])

  function apply(e: FormEvent) {
    e.preventDefault()
    const next = new URLSearchParams(params?.toString() ?? '')
    next.set('from', from)
    next.set('to', to)
    router.push(`${pathname}?${next.toString()}`)
  }

  return (
    <form className="flex items-end gap-2" onSubmit={apply}>
      <label className="flex flex-col text-xs text-neutral-600">
        From
        <Input
          type="date"
          name="from"
          value={from}
          max={to}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className="flex flex-col text-xs text-neutral-600">
        To
        <Input
          type="date"
          name="to"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <Button type="submit" variant="secondary">
        Update
      </Button>
    </form>
  )
}
