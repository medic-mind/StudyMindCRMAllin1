// Duplicate-contacts page. Duplicates are merged FULLY AUTOMATICALLY (ADR 0047,
// widened 2026-07) — every contact sharing an email or a phone is combined into
// its oldest record, hourly and again whenever this page is opened (the client
// drains the backlog synchronously so a self-hosted Inngest that never fires the
// cron can't leave duplicates un-merged). There is NO manual merge on this page:
// it only reports status — normally "all clear". The single control is
// CONTACTS_AUTO_MERGE=off, which pauses the automation. Explicit hand-merging (a
// power-user path, not a review queue) lives on the /contacts select-and-merge
// tool, not here.

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
