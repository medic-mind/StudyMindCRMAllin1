// /mail — the email workspace (ADR 0021 Phase 4). A three-pane mail client
// (account/folder rail · thread list · reading pane) over the unified email
// Conversation heads, fully synced with Gmail. The shell fetches the visible
// accounts; `MailWorkspace` drives the rest client-side. CLAUDE.md §14, §26.

import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { MailWorkspace } from './MailWorkspace'

export const dynamic = 'force-dynamic'

export default async function MailPage() {
  const caller = await createServerCaller()
  let accounts: Awaited<ReturnType<typeof caller.mail.accounts>> = []
  let forbidden = false
  try {
    accounts = await caller.mail.accounts()
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') forbidden = true
    else throw err
  }

  if (forbidden) {
    return (
      <>
        <PageHeader title="Mail" subtitle="Email workspace" />
        <PageBody>
          <p className="text-sm text-neutral-600">You need a staff role to view mail.</p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Mail"
        subtitle="Your email, across every connected account — fully synced with Gmail."
      />
      <PageBody>
        <MailWorkspace
          accounts={accounts.map((a) => ({
            id: a.id,
            address: a.address,
            displayName: a.displayName,
            signatureHtml: a.signatureHtml,
          }))}
        />
      </PageBody>
    </>
  )
}
