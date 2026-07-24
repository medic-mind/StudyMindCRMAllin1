// Pipeline stage management. ADR 0015. Open to every staff role (2026-07 — VA
// and above can do anything operational); the pipeline tRPC mutations still
// gate + audit each write server-side. CLAUDE.md §20.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { ManageStagesTable } from './ManageStagesTable'

export const dynamic = 'force-dynamic'

export default async function PipelineManagePage() {
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
