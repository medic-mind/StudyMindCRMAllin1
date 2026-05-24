// Pipeline stage management. ADR 0015. CEO + Senior Manager only.
// CLAUDE.md §20 (UI hides what the user cannot do; server gates also fire).

import { redirect } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { ManageStagesTable } from './ManageStagesTable'

export const dynamic = 'force-dynamic'

export default async function PipelineManagePage() {
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  if (role !== 'ceo' && role !== 'senior_manager') {
    redirect('/pipeline')
  }

  const caller = await createServerCaller()
  const stages = await caller.pipeline.stages.listIncludingArchived()
  const active = stages.filter((s) => s.archivedAt === null)
  const archived = stages.filter((s) => s.archivedAt !== null)

  return (
    <>
      <PageHeader
        title="Manage pipeline stages"
        subtitle="Create, rename, reorder, and archive the columns on the sales pipeline. Every change is audited."
        breadcrumbs={[
          { label: 'Pipeline', href: '/pipeline' },
          { label: 'Manage', href: '/pipeline/manage' },
        ]}
      />
      <PageBody>
        <ManageStagesTable
          active={active.map((s) => ({
            id: s.id,
            name: s.name,
            position: s.position,
            color: s.color,
            isClosed: s.isClosed,
          }))}
          archived={archived.map((s) => ({
            id: s.id,
            name: s.name,
            color: s.color,
            isClosed: s.isClosed,
          }))}
        />
      </PageBody>
    </>
  )
}
