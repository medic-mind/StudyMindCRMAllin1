// Aircall analytics. Thin RSC shell — auth/role + initial URL state only; the
// report itself is the AircallWorkspace client component, which drives ONE
// cached tRPC query so every filter click responds instantly (no full-page
// server round-trip per click, which is what made the old version feel broken
// and slow). Three tabs: Overview · Peak times · Performance + PDF export.
// CLAUDE.md §10, §26.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'

import { parsePeriod } from '../period'
import { AircallWorkspace } from './AircallWorkspace'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
  direction?: string
  provider?: string
  view?: string
}

export default async function AircallReportPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const period = parsePeriod(sp)
  const direction =
    sp.direction === 'inbound' || sp.direction === 'outbound' ? sp.direction : 'all'
  const provider =
    sp.provider === 'aircall' || sp.provider === 'google_voice' || sp.provider === 'manual'
      ? sp.provider
      : 'all'
  const view = sp.view === 'peak' || sp.view === 'performance' ? sp.view : 'overview'

  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const canManage = role === 'ceo' || role === 'senior_manager' || role === 'manager'

  return (
    <>
      <PageHeader
        title="Aircall analytics"
        subtitle="Volumes, peak times, duration distribution, and call quality"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Aircall', href: '/reports/aircall' },
        ]}
      />
      <PageBody>
        <AircallWorkspace
          initial={{
            fromIso: period.fromIso,
            toIso: period.toIso,
            direction,
            provider,
            view,
          }}
          canManage={canManage}
        />
      </PageBody>
    </>
  )
}
