// Protocols & Policies — the company knowledge base imported from the
// internal Crib site (ADR 0040). Read-only for all staff: grouped, colour-
// coded section cards over the LIVE content (baseline + any in-app edits),
// keyword search, and links to the AI Knowledge assistant and (CEO / Senior
// Manager) the AI editor.

import Link from 'next/link'

import { KNOWLEDGE_GROUP_ORDER, loadKnowledgeStore } from '@studymind/core/knowledge'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { groupStyle } from '@/components/knowledge/group-style'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { ChevronRightIcon, PencilIcon, SparklesIcon } from '@/components/ui/icon'
import { sectionItemCount } from '@/lib/knowledge/present'

import { KnowledgeSearch } from './KnowledgeSearch'

export const dynamic = 'force-dynamic'

// The sections agents reach for mid-call — mirrors the Crib homepage's
// quick links. Filtered against the live store so an edited/renamed
// knowledge base never renders a dead link.
const QUICK_LINK_SLUGS = [
  'master-pricing',
  'scripts',
  'pricing',
  'upsell',
  'live-days',
  'mmi-circuits',
] as const

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

          {(() => {
            const quick = QUICK_LINK_SLUGS.map((slug) =>
              store.sections.find((s) => s.slug === slug),
            ).filter((s): s is NonNullable<typeof s> => !!s)
            if (quick.length === 0) return null
            return (
              <section aria-label="Most used">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
                  Most used
                </h2>
                <div className="flex flex-wrap gap-2">
                  {quick.map((section) => {
                    const style = groupStyle(section.group)
                    const { Icon } = style
                    return (
                      <Link
                        key={section.slug}
                        href={`/protocols/${section.slug}`}
                        className={`flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-800 shadow-sm transition-colors ${style.hover}`}
                      >
                        <span
                          aria-hidden
                          className={`flex h-5 w-5 items-center justify-center rounded ${style.chip}`}
                        >
                          <Icon size={12} />
                        </span>
                        {section.title}
                      </Link>
                    )
                  })}
                </div>
              </section>
            )
          })()}

          {KNOWLEDGE_GROUP_ORDER.map((group) => {
            const inGroup = store.sections.filter((s) => s.group === group)
            if (inGroup.length === 0) return null
            const style = groupStyle(group)
            const { Icon } = style
            return (
              <section key={group} aria-label={group}>
                <div className="mb-3 flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className={`flex h-7 w-7 items-center justify-center rounded-lg ${style.chip}`}
                  >
                    <Icon size={16} />
                  </span>
                  <h2 className="text-sm font-semibold text-neutral-800">{group}</h2>
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-500">
                    {inGroup.length}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {inGroup.map((section) => {
                    const count = sectionItemCount(store.data[section.dataKey])
                    return (
                      <Link
                        key={section.slug}
                        href={`/protocols/${section.slug}`}
                        className="group"
                      >
                        <div
                          className={`flex h-full flex-col rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition-colors ${style.hover}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold text-neutral-900">
                              {section.title}
                            </h3>
                            <ChevronRightIcon
                              size={16}
                              className="shrink-0 text-neutral-300 transition-transform group-hover:translate-x-0.5 group-hover:text-neutral-500"
                            />
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                            {section.blurb}
                          </p>
                          {count !== null && count > 1 ? (
                            <span className="mt-2 pt-1 text-[11px] font-medium tabular-nums text-neutral-400">
                              {count} entries
                            </span>
                          ) : null}
                        </div>
                      </Link>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </PageBody>
    </>
  )
}
