// Serialises a knowledge render tree to indented plain text. Used for
// search snippets and as the per-section text the AI-context scorer reads,
// so what the search and the assistant "see" matches the rendered page.

import { toRenderTree } from './render-tree'
import { getKnowledgeSectionData } from './store'
import type { KnowledgeNode, KnowledgeStore } from './types'

function indentOf(depth: number): string {
  return '  '.repeat(depth)
}

export function renderToPlainText(node: KnowledgeNode, depth = 0): string {
  const pad = indentOf(depth)
  switch (node.kind) {
    case 'text':
      return pad + node.text
    case 'list':
      return node.items
        .map((item) =>
          item.kind === 'text'
            ? `${pad}- ${item.text}`
            : `${pad}-\n${renderToPlainText(item, depth + 1)}`,
        )
        .join('\n')
    case 'table': {
      const lines = node.rows.map((row) => {
        const cells = row
          .map((cell, i) => `${node.columns[i] ?? ''}: ${cell}`)
          .join(' | ')
        return `${pad}- ${cells}`
      })
      return lines.join('\n')
    }
    case 'entries':
      return node.entries
        .map((entry) => {
          if (entry.node.kind === 'text') {
            return `${pad}${entry.label}: ${entry.node.text}`
          }
          return `${pad}${entry.label}:\n${renderToPlainText(entry.node, depth + 1)}`
        })
        .join('\n')
    case 'cards':
      return node.cards
        .map((card) => {
          const heading = card.title ? `${pad}${card.title}` : `${pad}-`
          return `${heading}\n${renderToPlainText(card.node, depth + 1)}`
        })
        .join('\n')
  }
}

// Keyed on (store version, slug). The store version changes on every saved
// edit, so the cache can never serve stale text; the size cap just stops
// unbounded growth across many override versions.
const sectionTextCache = new Map<string, string>()
const SECTION_TEXT_CACHE_MAX = 200

/** Plain-text rendering of one whole section of a store (cached). */
export function knowledgeSectionPlainText(store: KnowledgeStore, slug: string): string {
  const key = `${store.version}:${slug}`
  const cached = sectionTextCache.get(key)
  if (cached !== undefined) return cached
  const data = getKnowledgeSectionData(store, slug)
  const text = data === undefined ? '' : renderToPlainText(toRenderTree(data))
  if (sectionTextCache.size >= SECTION_TEXT_CACHE_MAX) sectionTextCache.clear()
  sectionTextCache.set(key, text)
  return text
}
