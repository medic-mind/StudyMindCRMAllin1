// AI editor for the Protocols & Policies knowledge base (ADR 0040) — the
// CRM port of the Crib's super-admin AI editor. CEO / Senior Manager only
// (the tRPC procedures enforce this too; the redirect just keeps the UI
// honest). Describe a change in plain English → review the proposed
// patches → apply. Reset returns to the imported baseline.

import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { KnowledgeEditor } from './KnowledgeEditor'

export const dynamic = 'force-dynamic'

export default async function KnowledgeEditPage() {
  const me = await getCurrentUser()
  if (me?.role !== 'ceo' && me?.role !== 'senior_manager') {
    redirect('/protocols')
  }

  return (
    <>
      <PageHeader
        title="Edit knowledge"
        subtitle="Describe the change in plain English — the AI proposes the exact edits, you review and apply. Nothing changes without your confirmation."
        breadcrumbs={[
          { label: 'Protocols & Policies', href: '/protocols' },
          { label: 'Edit knowledge', href: '/protocols/edit' },
        ]}
      />
      <PageBody>
        <KnowledgeEditor />
      </PageBody>
    </>
  )
}
