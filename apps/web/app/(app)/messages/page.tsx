// Team messaging workspace (ADR 0022). Slack-style staff chat living inside the
// CRM: channels, DMs, threads, @mentions, reactions, and inline references to
// Contacts / Families / Cards / Tasks. CLAUDE.md §26 (RSC shell + client island),
// §20 (role gates enforced server-side in the chat router).

import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'

import { MessagesWorkspace } from './MessagesWorkspace'

export const dynamic = 'force-dynamic'

// Manager+ can administer channels (create/rename/archive/membership) and
// moderate (delete any message). Everyone else participates fully.
const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])
// Permanent channel deletion is one tier up — CEO + Senior Manager only.
const DELETE_ROLES = new Set(['ceo', 'senior_manager'])

export default async function MessagesPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')

  const canManageChannels = MANAGE_ROLES.has(me.role)
  const canDeleteChannels = DELETE_ROLES.has(me.role)

  return (
    <div className="-mx-6 -my-6">
      <MessagesWorkspace
        viewerId={me.id}
        canModerate={canManageChannels}
        canManageChannels={canManageChannels}
        canDeleteChannels={canDeleteChannels}
      />
    </div>
  )
}
