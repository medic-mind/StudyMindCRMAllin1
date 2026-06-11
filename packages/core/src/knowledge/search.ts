// Keyword search across the knowledge base (ADR 0040). Pure and
// in-memory — the index is built per store version (the version changes on
// every saved edit), so baseline and edited content search identically.

import { humaniseKey } from './render-tree'
import { getKnowledgeSectionData } from './store'
import type { KnowledgeSearchResult, KnowledgeStore, KnowledgeValue } from './types'

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

// Per-store-version index. Two slots cover the common case (baseline + the
// current override) without ever serving a stale index.
const indexCache = new Map<string, KnowledgeLeaf[]>()
const INDEX_CACHE_MAX = 2

function buildIndex(store: KnowledgeStore): KnowledgeLeaf[] {
  const leaves: KnowledgeLeaf[] = []
  for (const section of store.sections) {
    const data = getKnowledgeSectionData(store, section.slug)
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

function getIndex(store: KnowledgeStore): KnowledgeLeaf[] {
  const cached = indexCache.get(store.version)
  if (cached) return cached
  const built = buildIndex(store)
  if (indexCache.size >= INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value
    if (oldest !== undefined) indexCache.delete(oldest)
  }
  indexCache.set(store.version, built)
  return built
}

// Filler words score nothing on their own — "tell me about the camps" must
// rank on "camps", not on how often a big section says "the". If a query is
// ONLY stopwords we keep them, so it still returns something.
const STOPWORDS = new Set([
  'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or',
  'our', 'tell', 'that', 'the', 'this', 'to', 'us', 'we', 'what', 'when',
  'which', 'with', 'you', 'your',
])

export function tokeniseQuery(query: string): string[] {
  const all = query
    .toLowerCase()
    .split(/[^a-z0-9£+]+/)
    .filter((t) => t.length >= 2)
  const meaningful = all.filter((t) => !STOPWORDS.has(t))
  return meaningful.length > 0 ? meaningful : all
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

export function searchKnowledge(
  store: KnowledgeStore,
  query: string,
  limit = 20,
): KnowledgeSearchResult[] {
  const tokens = tokeniseQuery(query)
  if (tokens.length === 0) return []
  const phrase = query.trim().toLowerCase()

  const scored: Array<{ leaf: KnowledgeLeaf; score: number }> = []
  for (const leaf of getIndex(store)) {
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
