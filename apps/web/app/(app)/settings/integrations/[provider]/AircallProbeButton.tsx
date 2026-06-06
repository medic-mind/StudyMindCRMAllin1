// Live Aircall connectivity check. Calls the Aircall REST API with the
// configured keys and reports whether they work + how many calls Aircall sees.
// This distinguishes "keys missing/wrong" from "webhook not delivering" from
// "Aircall account has no calls" when import looks broken. CEO / Senior Manager
// only (the server procedure enforces it too). CLAUDE.md §10.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

type ProbeResult =
  | { ok: true; totalCallsVisible: number | null; mostRecentCallAt: string | Date | null }
  | { ok: false; error: string }

function fmt(d: string | Date | null): string {
  if (!d) return 'unknown time'
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(d),
  )
}

export function AircallProbeButton(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const probe = trpc.admin.integrations.probeAircall.useMutation({
    onSuccess: (r) => {
      setResult(r)
      if (r.ok) toast.success('Aircall API reachable')
      else toast.error('Aircall API check failed')
    },
    onError: (e) => {
      setResult({ ok: false, error: e.message ?? 'Probe failed' })
      toast.error(e.message ?? 'Probe failed')
    },
  })

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={probe.isPending}
        onClick={() => probe.mutate()}
      >
        {probe.isPending ? 'Testing…' : 'Test Aircall connection'}
      </Button>
      {result ? (
        result.ok ? (
          <p className="max-w-xs text-right text-xs text-emerald-700">
            Connected — Aircall reports{' '}
            {result.totalCallsVisible != null ? result.totalCallsVisible : 'an unknown number of'}{' '}
            call{result.totalCallsVisible === 1 ? '' : 's'}
            {result.mostRecentCallAt
              ? `, most recent ${fmt(result.mostRecentCallAt)}.`
              : '.'}
          </p>
        ) : (
          <p className="max-w-xs text-right text-xs text-red-700">Failed: {result.error}</p>
        )
      ) : null}
    </div>
  )
}
