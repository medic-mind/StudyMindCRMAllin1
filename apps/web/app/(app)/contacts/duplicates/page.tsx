// Duplicate-contacts page. Duplicates are merged FULLY AUTOMATICALLY (ADR 0047,
// widened 2026-07) — every contact sharing an email or a phone is combined into
// its oldest record, hourly and again whenever this page is opened (the client
// drains the backlog synchronously so a self-hosted Inngest that never fires the
// cron can't leave duplicates asking for a manual merge). This page therefore
// normally shows nothing; the manual per-cluster merge remains as a fallback for
// when automation is paused (CONTACTS_AUTO_MERGE=off) or a group genuinely can't
// be auto-merged (a restricted-access safeguarding conflict, §41.1).

import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { DuplicatesList } from './DuplicatesList'

export const dynamic = 'force-dynamic'

export default async function DuplicateContactsPage() {
  const me = await getCurrentUser()
  if (
    !me ||
    !['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'].includes(me.role)
  ) {
    return (
      <>
        <PageHeader
          title="Duplicate contacts"
          breadcrumbs={[
            { label: 'B2C Customers', href: '/contacts' },
            { label: 'Duplicates', href: '/contacts/duplicates' },
          ]}
        />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need the Manager, Senior Manager, or CEO role to review and merge
            duplicate contacts.
          </p>
        </PageBody>
      </>
    )
  }

  const caller = await createServerCaller()
  let data: Awaited<ReturnType<typeof caller.contact.duplicates.find>>
  try {
    data = await caller.contact.duplicates.find({ limit: 100 })
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      return (
        <PageBody>
          <p className="text-sm text-neutral-600">Forbidden.</p>
        </PageBody>
      )
    }
    throw err
  }

  return (
    <>
      <PageHeader
        title="Duplicate contacts"
        subtitle="The same person saved twice is merged automatically — combined into their oldest record with all their history. This page finishes any outstanding merges the moment you open it, so you don't need to review or confirm anything."
        breadcrumbs={[
          { label: 'B2C Customers', href: '/contacts' },
          { label: 'Duplicates', href: '/contacts/duplicates' },
        ]}
      />
      <PageBody>
        <DuplicatesList initialData={data} />
      </PageBody>
    </>
  )
}
