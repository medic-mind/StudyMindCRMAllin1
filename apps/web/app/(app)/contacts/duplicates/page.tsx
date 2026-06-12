// Duplicate-contacts cleanup. Surfaces clusters of contacts that share a
// normalised email or phone (so the same person, saved twice, lines up) and
// lets a Manager+ merge each cluster with one click. The human confirms every
// merge (§3 — never auto-merge); merging re-parents all history onto the
// survivor and soft-deletes the rest via the existing contact.bulkMerge path.

import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { DuplicatesList } from './DuplicatesList'

export const dynamic = 'force-dynamic'

export default async function DuplicateContactsPage() {
  const me = await getCurrentUser()
  if (!me || !['ceo', 'senior_manager', 'manager'].includes(me.role)) {
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
        subtitle="The same person saved more than once — grouped by shared email or phone number. Merge a group to combine all their history onto one contact. Nothing is merged until you confirm it."
        breadcrumbs={[
          { label: 'B2C Customers', href: '/contacts' },
          { label: 'Duplicates', href: '/contacts/duplicates' },
        ]}
      />
      <PageBody>
        <DuplicatesList
          initialClusters={data.clusters}
          totalClusters={data.totalClusters}
          duplicateContacts={data.duplicateContacts}
          capped={data.capped}
        />
      </PageBody>
    </>
  )
}
