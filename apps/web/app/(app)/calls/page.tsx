// Missed calls workspace (CLAUDE.md §10). A queue of inbound calls nobody
// answered (rang out OR voicemail), including unknown numbers, with whether
// each has been called back. "Called back" is derived from a later outbound
// call to the same number, so calling someone back — from here, the contact
// page, or Aircall itself — clears it automatically. RSC shell; the list +
// per-row actions are a client island. Read: any staff; action: Sales Exec+.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { MissedCallsWorkspace } from './MissedCallsWorkspace'

export const dynamic = 'force-dynamic'

type Filter = 'outstanding' | 'called_back' | 'all'

interface SP {
  filter?: string
  days?: string
}

const ACTION_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

export default async function MissedCallsPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const filter: Filter =
    sp.filter === 'called_back' || sp.filter === 'all' ? sp.filter : 'outstanding'
  const days = sp.days === '30' || sp.days === '365' ? Number(sp.days) : 90

  const me = await getCurrentUser()
  const canAction = ACTION_ROLES.has(me?.role ?? 'virtual_assistant')

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const caller = await createServerCaller()
  const data = await caller.calls.missed.list({ from, filter, limit: 300 })

  return (
    <>
      <PageHeader
        title="Missed calls"
        subtitle="Inbound calls to follow up. Call a number back and it clears itself automatically."
      />
      <PageBody>
        <MissedCallsWorkspace
          items={data.items}
          counts={data.counts}
          filter={filter}
          days={days}
          canAction={canAction}
        />
      </PageBody>
    </>
  )
}
