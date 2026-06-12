// Presentation heuristics for the knowledge renderer (ADR 0040). Pure +
// unit-tested: they decide HOW a piece of imported JSON should LOOK
// (a stat figure, a pricing grid, glossary cards, chips, a table…) so the
// section pages read as a designed dashboard, not a wall of text. The pure
// content transform for search/plain-text stays in @studymind/core
// (`toRenderTree`); this layer is web-only display intelligence.

import type { KnowledgeValue } from '@studymind/core/knowledge'
import { humaniseKey } from '@studymind/core/knowledge'

export type Scalar = string | number | boolean | null
export type KnowledgeObject = { [key: string]: KnowledgeValue }

export function isScalar(value: KnowledgeValue | undefined): value is Scalar {
  return value === null || (typeof value !== 'object')
}

export function isObject(value: KnowledgeValue | undefined): value is KnowledgeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function scalarText(value: Scalar): string {
  if (value === null) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

// A short, figure-like value worth rendering as a prominent stat rather
// than prose: money, hours, percentages, ratios, counts, short dates.
const STAT_RE =
  /^(£|\$)|\d+\s*(hours?|hrs?|h\b|%|×|x\b|days?|weeks?|mins?|minutes?)|^\d[\d,.\s–\-+/:×x]*$|→/i

export function looksLikeStat(text: string): boolean {
  const t = text.trim()
  if (t.length === 0 || t.length > 40) return false
  return STAT_RE.test(t)
}

/** Keys that name an item — used to pick a card/heading title. */
const TITLE_KEYS = [
  'name', 'title', 'label', 'tier', 'subject', 'term', 'question', 'test',
  'brand', 'product', 'stage', 'week', 'day', 'date', 'item', 'role', 'topic',
  'scenario',
] as const

export function pickTitleKey(obj: KnowledgeObject): string | null {
  for (const key of TITLE_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim().length > 0) return key
  }
  return null
}

const STAT_VALUE_KEYS = new Set(['value', 'price', 'amount', 'cost', 'rate'])
const STAT_NOTE_KEYS = new Set(['notes', 'note', 'detail', 'details', 'caption'])
const STAT_LABEL_KEYS = new Set(['label', 'name', 'term', 'tier'])

/**
 * A `{label, value, notes?}`-style record — the dominant shape in the
 * pricing / tutor-pay / discount-lever sections. Rendered as a stat card.
 */
export function asStatRecord(
  obj: KnowledgeObject,
): { label: string; value: string; note: string | null } | null {
  const keys = Object.keys(obj)
  if (keys.length === 0 || keys.length > 3) return null
  let label: string | null = null
  let value: string | null = null
  let note: string | null = null
  for (const key of keys) {
    const raw = obj[key]
    if (!isScalar(raw)) return null
    const text = scalarText(raw)
    const lower = key.toLowerCase()
    if (value === null && STAT_VALUE_KEYS.has(lower)) value = text
    else if (label === null && STAT_LABEL_KEYS.has(lower)) label = text
    else if (note === null && STAT_NOTE_KEYS.has(lower)) note = text
    else return null
  }
  if (label === null || value === null) return null
  return { label, value, note }
}

export function asGlossaryRecord(
  obj: KnowledgeObject,
): { term: string; definition: string } | null {
  const term = obj['term']
  const definition = obj['definition'] ?? obj['answer'] ?? obj['meaning']
  if (
    typeof term === 'string' &&
    term.trim() &&
    typeof definition === 'string' &&
    definition.trim()
  ) {
    return { term, definition }
  }
  // FAQ-style {question, answer}.
  const question = obj['question']
  const answer = obj['answer']
  if (
    Object.keys(obj).length <= 3 &&
    typeof question === 'string' &&
    question.trim() &&
    typeof answer === 'string' &&
    answer.trim()
  ) {
    return { term: question, definition: answer }
  }
  return null
}

const MAX_CHIP_LEN = 56
const MAX_TABLE_COLUMNS = 6
const MAX_TABLE_CELL = 90

function cellable(value: KnowledgeValue): boolean {
  if (isScalar(value)) return true
  return Array.isArray(value) && value.every(isScalar)
}

export type ArrayLayout =
  | 'empty'
  | 'chips'
  | 'bullets'
  | 'stats'
  | 'glossary'
  | 'cards'
  | 'table'
  | 'blocks'

export function classifyArray(items: readonly KnowledgeValue[]): ArrayLayout {
  if (items.length === 0) return 'empty'

  if (items.every(isScalar)) {
    const allShort = items.every(
      (i) => scalarText(i as Scalar).length <= MAX_CHIP_LEN,
    )
    return allShort && items.length <= 40 ? 'chips' : 'bullets'
  }

  if (items.every(isObject)) {
    const objs = items as KnowledgeObject[]
    if (objs.every((o) => asStatRecord(o) !== null)) return 'stats'
    if (objs.every((o) => asGlossaryRecord(o) !== null)) return 'glossary'

    const allCardLike = objs.every((o) => pickTitleKey(o) !== null)
    // Flat + cellable + few columns → table; but a title key usually means
    // these are richer records better shown as cards.
    const allFlat = objs.every((o) => Object.values(o).every(cellable))
    const colCount = new Set(objs.flatMap((o) => Object.keys(o))).size
    const hasProse = objs.some((o) =>
      Object.values(o).some(
        (v) => typeof v === 'string' && v.length > MAX_TABLE_CELL,
      ),
    )
    if (allCardLike) return 'cards'
    if (allFlat && colCount <= MAX_TABLE_COLUMNS && !hasProse) return 'table'
    return 'blocks'
  }

  return 'blocks'
}

/** Split an object's entries into scalar (def-grid) vs complex (subsections). */
export function partitionEntries(obj: KnowledgeObject): {
  scalars: Array<[string, Scalar]>
  complex: Array<[string, KnowledgeValue]>
} {
  const scalars: Array<[string, Scalar]> = []
  const complex: Array<[string, KnowledgeValue]> = []
  for (const [key, value] of Object.entries(obj)) {
    if (isScalar(value)) scalars.push([key, value])
    else complex.push([key, value])
  }
  return { scalars, complex }
}

/** Pull a lead summary/intro string off a section object, if present. */
const SUMMARY_KEYS = ['summary', 'intro', 'overview', 'description']

export function extractSummary(obj: KnowledgeObject): {
  summary: string | null
  rest: KnowledgeObject
} {
  for (const key of SUMMARY_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim().length > 0) {
      const rest: KnowledgeObject = {}
      for (const [k, val] of Object.entries(obj)) if (k !== key) rest[k] = val
      return { summary: v, rest }
    }
  }
  return { summary: null, rest: obj }
}

// ── Further display intelligence ───────────────────────────────────────────

/** Keys whose scalar arrays are sequential actions → numbered steps. */
const STEP_KEYS = new Set([
  'guidance',
  'steps',
  'process',
  'howitworks',
  'flow',
  'checklist',
  'sequence',
  'playbook',
  'stepladder',
])

export function isStepKey(key: string | undefined): boolean {
  if (!key) return false
  return STEP_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''))
}

/** Keys whose scalar arrays are an "included" feature list → checklist. */
const INCLUDES_KEYS = new Set([
  'includes',
  'included',
  'alwaysincluded',
  'features',
  'covers',
  'benefits',
  'whatyouget',
  'inclusions',
  'perks',
])

export function isIncludesKey(key: string | undefined): boolean {
  if (!key) return false
  return INCLUDES_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''))
}

/** Stable DOM anchor for a section key (TOC + deep links). */
export function anchorId(key: string): string {
  return `k-${key.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`
}

export interface TocEntry {
  id: string
  label: string
}

/** "On this page" entries — one per complex top-level key of a section. */
export function tocFor(data: KnowledgeValue): TocEntry[] {
  if (!isObject(data)) return []
  const { rest } = extractSummary(data)
  const { complex } = partitionEntries(rest)
  return complex.map(([key]) => ({ id: anchorId(key), label: humaniseKey(key) }))
}

/**
 * Catalogue detection: an object section whose complex entries are ALL
 * objects and numerous (products, hubs, brands) reads far better as a grid
 * of record cards than as a stack of full-width titled sections.
 */
export function asRecordGrid(
  entries: Array<[string, KnowledgeValue]>,
): Array<[string, KnowledgeObject]> | null {
  if (entries.length < 5) return null
  const objs: Array<[string, KnowledgeObject]> = []
  for (const [key, value] of entries) {
    if (!isObject(value)) return null
    objs.push([key, value])
  }
  return objs
}

/** Short categorical fields worth lifting into a header pill on a card. */
const BADGE_KEYS = new Set([
  'tone',
  'status',
  'brand',
  'level',
  'channel',
  'type',
  'category',
  'audience',
  'kind',
  'format',
])
const MAX_BADGE_LEN = 26

export interface CardParts {
  title: string | null
  /** [label, value] pairs for the header badge row (stats + categorical). */
  badges: Array<[string, string]>
  rest: KnowledgeObject
}

/** Split a record into a card title, header badges and the remaining body. */
export function cardParts(obj: KnowledgeObject, fallbackTitle?: string | null): CardParts {
  const titleKey = pickTitleKey(obj)
  const title = titleKey ? scalarText(obj[titleKey] as Scalar) : (fallbackTitle ?? null)

  const badges: Array<[string, string]> = []
  const rest: KnowledgeObject = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === titleKey) continue
    if (isScalar(value) && badges.length < 4) {
      const text = scalarText(value)
      const categorical = BADGE_KEYS.has(key.toLowerCase()) && text.length <= MAX_BADGE_LEN
      if (looksLikeStat(text) || categorical) {
        badges.push([humaniseKey(key), text])
        continue
      }
    }
    rest[key] = value
  }
  return { title, badges, rest }
}

/** Entry count for a section's index card ("31 entries"). */
export function sectionItemCount(data: KnowledgeValue | undefined): number | null {
  if (Array.isArray(data)) return data.length
  if (isObject(data)) return Object.keys(data).length
  return null
}
