// Generic renderer for the imported knowledge tree (ADR 0040). A pure
// presentational server component — the reshaping heuristics live in
// @studymind/core/knowledge (`toRenderTree`), so this file only decides
// how each node kind LOOKS. CLAUDE.md §26 (RSC by default), §28 (real
// tables are tables).

import type { KnowledgeNode } from '@studymind/core/knowledge'

interface Props {
  node: KnowledgeNode
  /** Nesting depth — drives heading size + card framing. */
  depth?: number
}

export function KnowledgeNodeView({ node, depth = 0 }: Props) {
  switch (node.kind) {
    case 'text':
      return (
        <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-700">
          {node.text}
        </p>
      )

    case 'list':
      return (
        <ul className="list-disc space-y-1 pl-5">
          {node.items.map((item, idx) => (
            <li key={idx} className="text-sm leading-relaxed text-neutral-700">
              {item.kind === 'text' ? (
                <span className="whitespace-pre-line">{item.text}</span>
              ) : (
                <KnowledgeNodeView node={item} depth={depth + 1} />
              )}
            </li>
          ))}
        </ul>
      )

    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left">
                {node.columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-neutral-500"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-neutral-100 align-top">
                  {row.map((cell, cellIdx) => (
                    <td
                      key={cellIdx}
                      className="whitespace-pre-line py-2 pr-4 leading-relaxed text-neutral-700"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'entries':
      return (
        <div className={depth === 0 ? 'space-y-6' : 'space-y-3'}>
          {node.entries.map((entry) => (
            <section key={entry.label}>
              {depth === 0 ? (
                <h2 className="mb-2 text-base font-semibold text-neutral-900">
                  {entry.label}
                </h2>
              ) : (
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {entry.label}
                </h3>
              )}
              <KnowledgeNodeView node={entry.node} depth={depth + 1} />
            </section>
          ))}
        </div>
      )

    case 'cards':
      return (
        <div className="space-y-3">
          {node.cards.map((card, idx) => (
            <div
              key={`${card.title ?? 'card'}-${idx}`}
              className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-4"
            >
              {card.title ? (
                <h3 className="mb-2 text-sm font-semibold text-neutral-900">
                  {card.title}
                </h3>
              ) : null}
              <KnowledgeNodeView node={card.node} depth={depth + 1} />
            </div>
          ))}
        </div>
      )
  }
}
