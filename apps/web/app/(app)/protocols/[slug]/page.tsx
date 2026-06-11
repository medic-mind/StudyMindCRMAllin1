// One knowledge section, rendered in full from the LIVE data — the
// imported baseline plus any in-app edits (ADR 0040). Read-only for all
// staff; the visual KnowledgeNodeView turns the raw JSON into stat tiles,
// glossary cards, badged record cards and styled tables, including
// sections added in-app by the AI editor.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  getKnowledgeSection,
  getKnowledgeSectionData,
  loadKnowledgeStore,
} from '@studymind/core/knowledge'

import { db } from '@/lib/db'
import { groupStyle } from '@/components/knowledge/group-style'
import { KnowledgeNodeView } from '@/components/knowledge/knowledge-node'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { SparklesIcon } from '@/components/ui/icon'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function ProtocolSectionPage({ params }: PageProps) {
  const { slug } = await params
  const store = await loadKnowledgeStore(db)
  const section = getKnowledgeSection(store, slug)
  const data = getKnowledgeSectionData(store, slug)
  if (!section || data === undefined) notFound()

  const style = groupStyle(section.group)
  const { Icon } = style
  const inGroup = store.sections.filter(
    (s) => s.group === section.group && s.slug !== section.slug,
  )

  return (
    <>
      <PageHeader
        title={section.title}
        subtitle={section.blurb}
        breadcrumbs={[
          { label: 'Protocols & Policies', href: '/protocols' },
          { label: section.title, href: `/protocols/${section.slug}` },
        ]}
        actions={
          <Link
            href="/protocols/ask"
            className="flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50"
          >
            <SparklesIcon size={16} />
            Ask AI Knowledge
          </Link>
        }
      />
      <PageBody>
        <div className="space-y-6">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={`flex h-7 w-7 items-center justify-center rounded-lg ${style.chip}`}
            >
              <Icon size={16} />
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400">
              {section.group}
            </span>
          </div>

          <KnowledgeNodeView data={data} tone={style.tone} />

          {inGroup.length > 0 ? (
            <section aria-label={`More in ${section.group}`}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400">
                More in {section.group}
              </h2>
              <div className="flex flex-wrap gap-2">
                {inGroup.map((s) => (
                  <Link
                    key={s.slug}
                    href={`/protocols/${s.slug}`}
                    className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-700 transition-colors hover:border-primary-300 hover:text-primary-700"
                  >
                    {s.title}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <p className="text-xs text-neutral-400">
            {store.edited
              ? 'Imported from the StudyMind team Crib, with in-app edits applied.'
              : 'Imported from the StudyMind team Crib.'}{' '}
            Always confirm live discount offers with Becca before quoting a
            customer.
          </p>
        </div>
      </PageBody>
    </>
  )
}
