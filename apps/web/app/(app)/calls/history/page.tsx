// Call history (CLAUDE.md §10). Every Aircall call — inbound + outbound,
// answered / missed / voicemail — newest first, with filters, recordings and a
// link to the matched contact. RSC shell; the filter bar + recording players
// are a client island. Read: any staff. Sibling of the Missed-calls workspace.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { CallHistoryTable } from './CallHistoryTable'

export const dynamic = 'force-dynamic'

type Direction = 'all' | 'inbound' | 'outbound'
type Outcome = 'all' | 'answered' | 'missed' | 'voicemail'

interface SP {
  direction?: string
  outcome?: string
  days?: string
  rec?: string
  page?: string
}

export default async function CallHistoryPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const direction: Direction =
    sp.direction === 'inbound' || sp.direction === 'outbound' ? sp.direction : 'all'
  const outcome: Outcome =
    sp.outcome === 'answered' || sp.outcome === 'missed' || sp.outcome === 'voicemail'
      ? sp.outcome
      : 'all'
  const days = sp.days === '7' || sp.days === '30' || sp.days === '365' ? Number(sp.days) : 90
  const withRecording = sp.rec === '1'
  const page = Math.max(1, Number(sp.page) || 1)
  const pageSize = 50

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const caller = await createServerCaller()
  const data = await caller.calls.history.list({
    from,
    direction,
    outcome,
    withRecording,
    page,
    pageSize,
  })

  return (
    <>
      <PageHeader
        title="Call history"
        subtitle="Every Aircall call — inbound and outbound — with recordings where available."
      />
      <PageBody>
        <CallHistoryTable
          items={data.items}
          counts={data.counts}
          direction={direction}
          outcome={outcome}
          days={days}
          withRecording={withRecording}
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          capped={data.capped}
        />
      </PageBody>
    </>
  )
}
