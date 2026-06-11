// AI Knowledge — ask questions of the imported company knowledge base
// (ADR 0040). The assistant is grounded on the full Protocols & Policies
// content via packages/ai; answers are advisory and clearly labelled.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { KnowledgeAssistant } from './KnowledgeAssistant'

export const dynamic = 'force-dynamic'

export default function AskKnowledgePage() {
  return (
    <>
      <PageHeader
        title="AI Knowledge"
        subtitle="Ask anything about products, pricing, schedules, playbooks or policies — answered from the Protocols & Policies knowledge base."
        breadcrumbs={[
          { label: 'Protocols & Policies', href: '/protocols' },
          { label: 'AI Knowledge', href: '/protocols/ask' },
        ]}
      />
      <PageBody>
        <KnowledgeAssistant />
      </PageBody>
    </>
  )
}
