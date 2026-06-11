// Keyword search across the imported knowledge base (ADR 0040). Pure and
// in-memory — the data is a static checked-in snapshot, so the index is
// built once per process and never invalidated.

import { humaniseKey } from './render-tree'
import { getKnowledgeSectionData, KNOWLEDGE_SECTIONS } from './sections'
import type { KnowledgeSearchResult, KnowledgeValue } from './types'

interface KnowledgeLeaf {
  sectionSlug: string
  sectionTitle: string
  path: string
  text: string
  lowerText: string
  lowerPath: string
  lowerTitle: string
}

const TITLE_KEYS = ['name', 'title', 'label', 'tier', 'subject', 'term', 'question'] as const

function arrayItemLabel(item: KnowledgeValue, index: number): string {
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    for (const key of TITLE_KEYS) {
      const candidate = (item as { [key: string]: KnowledgeValue })[key]
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
    }
  }
  return `#${index + 1}`
}

function collectLeaves(
  value: KnowledgeValue,
  pathLabels: string[],
  push: (pathLabels: string[], text: string) => void,
): void {
  if (value === null) return
  if (typeof value !== 'object') {
    push(pathLabels, String(value))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item !== null && typeof item === 'object') {
        collectLeaves(item, [...pathLabels, arrayItemLabel(item, index)], push)
      } else {
        collectLeaves(item, pathLabels, push)
      }
    })
    return
  }
  for (const [key, child] of Object.entries(value)) {
    collectLeaves(child, [...pathLabels, humaniseKey(key)], push)
  }
}

let leafIndex: KnowledgeLeaf[] | null = null

function buildIndex(): KnowledgeLeaf[] {
  const leaves: KnowledgeLeaf[] = []
  for (const section of KNOWLEDGE_SECTIONS) {
    const data = getKnowledgeSectionData(section.slug)
    if (data === undefined) continue
    collectLeaves(data, [], (pathLabels, text) => {
      const path = pathLabels.join(' › ')
      leaves.push({
        sectionSlug: section.slug,
        sectionTitle: section.title,
        path,
        text,
        lowerText: text.toLowerCase(),
        lowerPath: path.toLowerCase(),
        lowerTitle: section.title.toLowerCase(),
      })
    })
  }
  return leaves
}

function getIndex(): KnowledgeLeaf[] {
  if (!leafIndex) leafIndex = buildIndex()
  return leafIndex
}

export function tokeniseQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9£+]+/)
    .filter((t) => t.length >= 2)
}

function scoreLeaf(leaf: KnowledgeLeaf, tokens: string[], phrase: string): number {
  let score = 0
  let matched = 0
  for (const token of tokens) {
    let tokenHit = false
    if (leaf.lowerText.includes(token)) {
      score += 3
      tokenHit = true
    }
    if (leaf.lowerPath.includes(token)) {
      score += 2
      tokenHit = true
    }
    if (leaf.lowerTitle.includes(token)) {
      score += 2
      tokenHit = true
    }
    if (tokenHit) matched += 1
  }
  if (matched === 0) return 0
  if (matched < tokens.length) score = score / 4 // partial matches rank well below full ones
  if (phrase.length >= 4 && leaf.lowerText.includes(phrase)) score += 5
  return score
}

function makeSnippet(leaf: KnowledgeLeaf, tokens: string[]): string {
  const MAX = 220
  if (leaf.text.length <= MAX) return leaf.text
  let at = -1
  for (const token of tokens) {
    at = leaf.lowerText.indexOf(token)
    if (at >= 0) break
  }
  if (at < 0) at = 0
  const start = Math.max(0, at - 60)
  const end = Math.min(leaf.text.length, start + MAX)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < leaf.text.length ? '…' : ''
  return prefix + leaf.text.slice(start, end).trim() + suffix
}

export function searchKnowledge(query: string, limit = 20): KnowledgeSearchResult[] {
  const tokens = tokeniseQuery(query)
  if (tokens.length === 0) return []
  const phrase = query.trim().toLowerCase()

  const scored: Array<{ leaf: KnowledgeLeaf; score: number }> = []
  for (const leaf of getIndex()) {
    const score = scoreLeaf(leaf, tokens, phrase)
    if (score > 0) scored.push({ leaf, score })
  }
  scored.sort((a, b) => b.score - a.score)

  // One result per (section, path) — sibling leaves under the same label
  // would otherwise flood the list with near-duplicates.
  const seen = new Set<string>()
  const results: KnowledgeSearchResult[] = []
  for (const { leaf, score } of scored) {
    const key = `${leaf.sectionSlug}::${leaf.path}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({
      sectionSlug: leaf.sectionSlug,
      sectionTitle: leaf.sectionTitle,
      path: leaf.path,
      snippet: makeSnippet(leaf, tokens),
      score,
    })
    if (results.length >= limit) break
  }
  return results
}
