// PDF export of the Aircall report (CLAUDE.md §10). Reuses the same computation
// as the on-screen report via the tRPC server caller, then renders it through
// the first-party, dependency-free PDF writer. Manager+ only — the summary
// procedure enforces the role; we surface its FORBIDDEN / UNAUTHORIZED as
// 403 / 401 here.

import { TRPCError } from '@trpc/server'
import { NextResponse } from 'next/server'

import { AIRCALL_PDF_FILENAME, buildAircallReportPdf } from '@studymind/core/reports'

import { parsePeriod } from '@/app/(app)/reports/period'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

const DIRECTION_LABELS: Record<string, string> = {
  all: 'All calls',
  inbound: 'Inbound',
  outbound: 'Outbound',
}
const PROVIDER_LABELS: Record<string, string> = {
  all: 'All providers',
  aircall: 'Aircall',
  google_voice: 'Google Voice',
  manual: 'Manual log',
}
const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export async function GET(req: Request): Promise<NextResponse> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse(null, { status: 401 })

  const url = new URL(req.url)
  const period = parsePeriod({
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  })
  const directionRaw = url.searchParams.get('direction')
  const direction =
    directionRaw === 'inbound' || directionRaw === 'outbound' ? directionRaw : 'all'
  const providerRaw = url.searchParams.get('provider')
  const provider =
    providerRaw === 'aircall' || providerRaw === 'google_voice' || providerRaw === 'manual'
      ? providerRaw
      : 'all'

  let data: Awaited<ReturnType<Awaited<ReturnType<typeof createServerCaller>>['reports']['aircall']['summary']>>
  try {
    const caller = await createServerCaller()
    data = await caller.reports.aircall.summary({
      from: period.from,
      to: period.to,
      direction,
      provider,
    })
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      return new NextResponse(null, { status: 403 })
    }
    if (err instanceof TRPCError && err.code === 'UNAUTHORIZED') {
      return new NextResponse(null, { status: 401 })
    }
    throw err
  }

  const ps = data.peakStats
  const busiestLabel = ps.busiest
    ? `${DOW_SHORT[ps.busiest.dow] ?? ''} ${String(ps.busiest.hour).padStart(2, '0')}:00 — ${ps.busiest.count} call${ps.busiest.count === 1 ? '' : 's'}`
    : null
  const windowsById = new Map(data.peakWindows.map((w) => [w.id, w]))

  const pdf = buildAircallReportPdf({
    generatedAt: new Date(),
    period: { from: data.period.from, to: data.period.to },
    directionLabel: DIRECTION_LABELS[direction] ?? 'All calls',
    providerLabel: PROVIDER_LABELS[provider] ?? 'All providers',
    kpis: {
      total: data.kpis.total,
      answered: data.kpis.answered,
      answeredRate: data.kpis.answeredRate,
      voicemails: data.kpis.voicemails,
      missed: data.kpis.missed,
      inbound: data.kpis.inbound,
      outbound: data.kpis.outbound,
      avgDurationSec: data.kpis.avgDurationSec,
      totalTalkSec: data.kpis.totalTalkSec,
    },
    peak: {
      configured: ps.configured,
      windowCount: ps.windowCount,
      peakCalls: ps.peakCalls,
      offPeakCalls: ps.offPeakCalls,
      peakShare: ps.peakShare,
      peakAnsweredRate: ps.peakAnsweredRate,
      offPeakAnsweredRate: ps.offPeakAnsweredRate,
      peakTalkSec: ps.peakTalkSec,
      busiestLabel,
      windows: ps.byWindow.map((bw) => {
        const w = windowsById.get(bw.id)
        return {
          name: bw.name,
          season: w?.labels.season ?? '',
          days: w?.labels.days ?? '',
          hours: w?.labels.hours ?? '',
          year: w?.labels.year ?? '',
          calls: bw.calls,
          answered: bw.answered,
        }
      }),
    },
    topContacts: data.topContacts.map((c) => ({ name: c.name, kind: c.kind, count: c.count })),
  })

  // Node Buffer → Uint8Array for the web Response body.
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${AIRCALL_PDF_FILENAME}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
