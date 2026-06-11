// Protocols & Policies — the company knowledge base imported from the
// internal Crib site (ADR 0040). Read-only for all staff: grouped section
// cards over the LIVE content (baseline + any in-app edits), keyword
// search, and links to the AI Knowledge assistant and (CEO / Senior
// Manager) the AI editor.

import Link from 'next/link'

import { KNOWLEDGE_GROUP_ORDER, loadKnowledgeStore } from '@studymind/core/knowledge'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { PencilIcon, SparklesIcon } from '@/components/ui/icon'

import { KnowledgeSearch } from './KnowledgeSearch'

export const dynamic = 'force-dynamic'

export default async function ProtocolsPage() {
  const me = await getCurrentUser()
  const canEdit = me?.role === 'ceo' || me?.role === 'senior_manager'
  const store = await loadKnowledgeStore(db)

  return (
    <>
      <PageHeader
        title="Protocols & Policies"
        subtitle="The company knowledge base — products, pricing, playbooks and policies across every brand, imported from the team Crib."
        actions={
          <>
            {canEdit ? (
              <Link
                href="/protocols/edit"
                className="flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50"
              >
                <PencilIcon size={16} />
                Edit content
              </Link>
            ) : null}
            <Link
              href="/protocols/ask"
              className="flex h-9 items-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-primary-700"
            >
              <SparklesIcon size={16} />
              Ask AI Knowledge
            </Link>
          </>
        }
      />
      <PageBody>
        <div className="space-y-8">
          {store.edited ? (
            <p className="rounded-lg border border-primary-100 bg-primary-50/60 px-4 py-2.5 text-sm text-primary-800">
              This knowledge base includes in-app edits
              {store.updatedAt
                ? ` — last updated ${store.updatedAt.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}`
                : ''}
              . The imported Crib baseline can be restored from the editor.
            </p>
          ) : null}

          <KnowledgeSearch />

          {KNOWLEDGE_GROUP_ORDER.map((group) => {
            const inGroup = store.sections.filter((s) => s.group === group)
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
