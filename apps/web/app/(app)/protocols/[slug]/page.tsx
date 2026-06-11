// One knowledge section, rendered in full from the imported data
// (ADR 0040). Read-only for all staff; the generic KnowledgeNodeView
// guarantees every detail in the section renders even with no bespoke UI.

import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  getKnowledgeSection,
  getKnowledgeSectionData,
  listKnowledgeSections,
  toRenderTree,
} from '@studymind/core/knowledge'

import { KnowledgeNodeView } from '@/components/knowledge/knowledge-node'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { SparklesIcon } from '@/components/ui/icon'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function ProtocolSectionPage({ params }: PageProps) {
  const { slug } = await params
  const section = getKnowledgeSection(slug)
  const data = getKnowledgeSectionData(slug)
  if (!section || data === undefined) notFound()

  const sections = listKnowledgeSections()
  const inGroup = sections.filter(
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
          <Card className="p-5 sm:p-6">
            <KnowledgeNodeView node={toRenderTree(data)} />
          </Card>

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
            Imported from the StudyMind team Crib. Always confirm live discount
            offers with Becca before quoting a customer.
          </p>
        </div>
      </PageBody>
    </>
  )
}
