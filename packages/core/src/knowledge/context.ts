// Builds the grounding context for the AI Knowledge assistant (ADR 0040).
//
// The default char budget comfortably fits the WHOLE knowledge base — the
// assistant is grounded on everything, exactly like the Crib's own chatbot.
// Sections are still relevance-ordered so that (a) a smaller budget degrades
// gracefully by dropping the least relevant sections, and (b) the top scorers
// double as "read more" links in the UI.

import { knowledgeSectionPlainText } from './plain-text'
import { getKnowledgeSectionData, KNOWLEDGE_SECTIONS } from './sections'
import { tokeniseQuery } from './search'
import type { KnowledgeContext, KnowledgeContextSection } from './types'

/** Fits the full knowledge base (~330k chars serialised) with headroom. */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 400_000

const RELATED_SECTIONS = 5

function scoreSection(slug: string, title: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const text = knowledgeSectionPlainText(slug).toLowerCase()
  const lowerTitle = title.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lowerTitle.includes(token)) score += 10
    // Occurrence count, capped so one giant section cannot drown the rest.
    let count = 0
    let at = text.indexOf(token)
    while (at >= 0 && count < 20) {
      count += 1
      at = text.indexOf(token, at + token.length)
    }
    score += count
  }
  return score
}

export function buildKnowledgeContext(
  question: string,
  maxChars = DEFAULT_CONTEXT_CHAR_BUDGET,
): KnowledgeContext {
  const tokens = tokeniseQuery(question)

  const ranked = KNOWLEDGE_SECTIONS.map((section) => ({
    section,
    score: scoreSection(section.slug, section.title, tokens),
  })).sort((a, b) => b.score - a.score)

  const included: KnowledgeContextSection[] = []
  const parts: string[] = []
  let used = 2 // the surrounding `{}` braces
  let truncated = false

  for (const { section, score } of ranked) {
    const data = getKnowledgeSectionData(section.slug)
    if (data === undefined) continue
    const serialised = `${JSON.stringify(section.dataKey)}:${JSON.stringify(data)}`
    // Skip what does not fit and keep walking — a huge section must not
    // starve the smaller (often more specific) ones behind it.
    if (used + serialised.length + 1 > maxChars) {
      truncated = true
      continue
    }
    parts.push(serialised)
    used += serialised.length + 1
    included.push({ slug: section.slug, title: section.title, score })
  }

  // Degenerate budget (smaller than every single section): better an
  // oversized context than an empty one — include the top-ranked section.
  if (included.length === 0 && ranked.length > 0) {
    const top = ranked[0]
    if (top) {
      const data = getKnowledgeSectionData(top.section.slug)
      if (data !== undefined) {
        parts.push(`${JSON.stringify(top.section.dataKey)}:${JSON.stringify(data)}`)
        included.push({ slug: top.section.slug, title: top.section.title, score: top.score })
      }
    }
  }

  const related = ranked
    .filter(({ score }) => score > 0)
    .slice(0, RELATED_SECTIONS)
    .map(({ section, score }) => ({ slug: section.slug, title: section.title, score }))

  return {
    contextJson: `{${parts.join(',')}}`,
    included,
    related,
    truncated,
  }
}
