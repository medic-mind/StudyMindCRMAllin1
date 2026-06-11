// Live Trengo connectivity check. Calls the Trengo REST API with the
// CALLER's own per-agent token and reports whether it works + how many
// tickets Trengo sees. This distinguishes "token missing/expired" from
// "webhook not delivering" from "import never ran" when nothing is showing
// up. CEO / Senior Manager only (the server procedure enforces it too).
// CLAUDE.md §11.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

type ProbeResult =
  | { ok: true; trengoEmail: string | null; ticketsVisible: number | null }
  | { ok: false; error: string }

export function TrengoProbeButton(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const probe = trpc.admin.integrations.probeTrengo.useMutation({
    onSuccess: (r) => {
      setResult(r)
      if (r.ok) toast.success('Trengo API reachable')
      else toast.error('Trengo API check failed')
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
        {probe.isPending ? 'Testing…' : 'Test Trengo connection'}
      </Button>
      {result ? (
        result.ok ? (
          <p className="max-w-xs text-right text-xs text-emerald-700">
            Connected{result.trengoEmail ? ` as ${result.trengoEmail}` : ''} — Trengo
            reports{' '}
            {result.ticketsVisible != null
              ? result.ticketsVisible
              : 'an unknown number of'}{' '}
            ticket{result.ticketsVisible === 1 ? '' : 's'}.
          </p>
        ) : (
          <p className="max-w-xs text-right text-xs text-red-700">Failed: {result.error}</p>
        )
      ) : null}
    </div>
  )
}
