// "On this page" rail for long knowledge sections (ADR 0040) — the CRM
// port of the Crib's per-page TOC. Server component: plain anchor links to
// the section ids KnowledgeNodeView emits; sticky on xl+ screens, hidden
// below (the content is the priority on small screens).

import type { TocEntry } from '@/lib/knowledge/present'

export function KnowledgeToc({ entries }: { entries: TocEntry[] }) {
  return (
    <nav
      aria-label="On this page"
      className="sticky top-6 hidden max-h-[calc(100vh-3rem)] overflow-y-auto xl:block"
    >
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
        On this page
      </p>
      <ul className="space-y-px border-l border-neutral-200">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${entry.id}`}
              className="-ml-px block border-l border-transparent py-1 pl-3 pr-2 text-xs leading-snug text-neutral-500 transition-colors hover:border-primary-400 hover:text-primary-700"
            >
              {entry.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
