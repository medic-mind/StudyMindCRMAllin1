// Communication Centre — the unified customer inbox (ADR 0020). CLAUDE.md §11,
// §20, §26. The shell resolves the signed-in agent and the initial view/channel
// /selection from the URL, then hands off to the client cockpit
// (`InboxCockpit`), which drives the live 3-pane Trengo-style experience. `/inbox`
// redirects here, so this is the single canonical customer inbox.

import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'

import { type InboxChannel, type InboxFilter } from './cockpit-shared'
import { InboxCockpit } from './InboxCockpit'

export const dynamic = 'force-dynamic'

const FILTERS: ReadonlyArray<InboxFilter> = ['active', 'mine', 'unassigned', 'snoozed', 'closed']
const CHANNELS: ReadonlyArray<InboxChannel> = ['whatsapp', 'sms', 'email', 'web_chat']

function one(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

function parseFilter(raw: string | string[] | undefined): InboxFilter {
  const v = one(raw)
  return FILTERS.includes(v as InboxFilter) ? (v as InboxFilter) : 'active'
}

function parseChannel(raw: string | string[] | undefined): InboxChannel | null {
  const v = one(raw)
  return CHANNELS.includes(v as InboxChannel) ? (v as InboxChannel) : null
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    filter?: string | string[]
    channel?: string | string[]
    c?: string | string[]
  }>
}) {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')

  const params = await searchParams
  const initialSelectedId = one(params.c) ?? null

  return (
    <div className="-mx-6 -my-6">
      <InboxCockpit
        me={{ id: me.id, name: me.name ?? null, role: me.role }}
        initialFilter={parseFilter(params.filter)}
        initialChannel={parseChannel(params.channel)}
        initialSelectedId={initialSelectedId}
      />
    </div>
  )
}
