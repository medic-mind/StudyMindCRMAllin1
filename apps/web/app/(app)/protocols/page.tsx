// Protocols & Policies — the company knowledge base imported from the
// internal Crib site (ADR 0040). Read-only for all staff: grouped section
// cards over the full imported content, plus keyword search and a link to
// the AI Knowledge assistant.

import Link from 'next/link'

import {
  KNOWLEDGE_GROUP_ORDER,
  listKnowledgeSections,
} from '@studymind/core/knowledge'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { SparklesIcon } from '@/components/ui/icon'

import { KnowledgeSearch } from './KnowledgeSearch'

export const dynamic = 'force-dynamic'

export default function ProtocolsPage() {
  const sections = listKnowledgeSections()

  return (
    <>
      <PageHeader
        title="Protocols & Policies"
        subtitle="The company knowledge base — products, pricing, playbooks and policies across every brand, imported from the team Crib."
        actions={
          <Link
            href="/protocols/ask"
            className="flex h-9 items-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-primary-700"
          >
            <SparklesIcon size={16} />
            Ask AI Knowledge
          </Link>
        }
      />
      <PageBody>
        <div className="space-y-8">
          <KnowledgeSearch />

          {KNOWLEDGE_GROUP_ORDER.map((group) => {
            const inGroup = sections.filter((s) => s.group === group)
            if (inGroup.length === 0) return null
            return (
              <section key={group} aria-label={group}>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400">
                  {group}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {inGroup.map((section) => (
                    <Link key={section.slug} href={`/protocols/${section.slug}`}>
                      <Card className="h-full p-4 transition-colors hover:border-primary-300 hover:bg-primary-50/30">
                        <h3 className="text-sm font-semibold text-neutral-900">
                          {section.title}
                        </h3>
                        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                          {section.blurb}
                        </p>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </PageBody>
    </>
  )
}
