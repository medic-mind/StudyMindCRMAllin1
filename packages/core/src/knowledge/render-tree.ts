// Reshapes arbitrary imported knowledge JSON into a display tree
// (ADR 0040). Pure — shared by the web renderer, the plain-text serialiser
// and the search index, so all three present the data identically.

import type {
  KnowledgeCard,
  KnowledgeEntry,
  KnowledgeNode,
  KnowledgeValue,
} from './types'

/** Tokens always rendered upper-case when humanising a key. */
const ACRONYMS = new Set([
  'ai',
  'ap',
  'bac',
  'b2b',
  'cv',
  'doe',
  'esat',
  'faq',
  'gamsat',
  'gcse',
  'gp',
  'hsps',
  'ib',
  'id',
  'ielts',
  'ks1',
  'ks2',
  'ks3',
  'ks4',
  'lnat',
  'mmi',
  'nhs',
  'ppe',
  'ps',
  'sen',
  'sqa',
  'tara',
  'tmua',
  'toefl',
  'ucas',
  'ucat',
  'uk',
  'url',
  'usd',
  'va',
  'vip',
])

/**
 * "moneyBackGuarantee" → "Money back guarantee", "ucatNote" → "UCAT note",
 * "faq" → "FAQ". Splits camelCase, snake_case and kebab-case.
 */
export function humaniseKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  const cased = words.map((word, idx) => {
    const lower = word.toLowerCase()
    if (ACRONYMS.has(lower)) return lower.toUpperCase()
    if (idx === 0) return lower.charAt(0).toUpperCase() + lower.slice(1)
    return lower
  })
  return cased.join(' ')
}

function isScalar(value: KnowledgeValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object'
}

function isPlainObject(value: KnowledgeValue): value is { [key: string]: KnowledgeValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scalarText(value: string | number | boolean | null): string {
  if (value === null) return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

/** Keys we try (in order) when picking a card's title. */
const TITLE_KEYS = [
  'name',
  'title',
  'label',
  'tier',
  'subject',
  'term',
  'question',
  'test',
  'brand',
  'product',
  'stage',
  'week',
  'day',
  'date',
  'item',
  'role',
] as const

const MAX_TABLE_COLUMNS = 8
// A row with prose-length cells (step lists, long notes) reads far better as
// a titled card than as a cramped table row.
const MAX_TABLE_CELL_CHARS = 140

/** A value renderable inside a single table cell. */
function isCellValue(value: KnowledgeValue): boolean {
  if (isScalar(value)) return true
  if (Array.isArray(value)) return value.every(isScalar)
  return false
}

function cellText(value: KnowledgeValue | undefined): string {
  if (value === undefined) return '—'
  if (isScalar(value)) return scalarText(value)
  if (Array.isArray(value)) return value.map((v) => scalarText(v as never)).join(', ')
  return '—'
}

function unionKeys(objects: Array<{ [key: string]: KnowledgeValue }>): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
  return keys
}

function tryTable(objects: Array<{ [key: string]: KnowledgeValue }>): KnowledgeNode | null {
  const keys = unionKeys(objects)
  if (keys.length === 0 || keys.length > MAX_TABLE_COLUMNS) return null
  const allCellable = objects.every((obj) => keys.every((k) => obj[k] === undefined || isCellValue(obj[k] as KnowledgeValue)))
  if (!allCellable) return null
  const rows = objects.map((obj) => keys.map((k) => cellText(obj[k])))
  const tooProsy = rows.some((row) => row.some((cell) => cell.length > MAX_TABLE_CELL_CHARS))
  if (tooProsy) return null
  return {
    kind: 'table',
    columns: keys.map(humaniseKey),
    rows,
  }
}

function toCards(objects: Array<{ [key: string]: KnowledgeValue }>): KnowledgeNode {
  const cards: KnowledgeCard[] = objects.map((obj) => {
    let title: string | null = null
    let titleKey: string | null = null
    for (const key of TITLE_KEYS) {
      const candidate = obj[key]
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        title = candidate
        titleKey = key
        break
      }
    }
    const rest: { [key: string]: KnowledgeValue } = {}
    for (const [key, value] of Object.entries(obj)) {
      if (key !== titleKey) rest[key] = value
    }
    return { title, node: toRenderTree(rest) }
  })
  return { kind: 'cards', cards }
}

export function toRenderTree(value: KnowledgeValue | undefined): KnowledgeNode {
  if (value === undefined || value === null) return { kind: 'text', text: '—' }

  if (isScalar(value)) return { kind: 'text', text: scalarText(value) }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'text', text: '—' }
    if (value.every(isScalar)) {
      return {
        kind: 'list',
        items: value.map((v) => ({ kind: 'text' as const, text: scalarText(v as never) })),
      }
    }
    if (value.every(isPlainObject)) {
      const objects = value as Array<{ [key: string]: KnowledgeValue }>
      return tryTable(objects) ?? toCards(objects)
    }
    return { kind: 'list', items: value.map((v) => toRenderTree(v)) }
  }

  const entries: KnowledgeEntry[] = Object.entries(value).map(([key, child]) => ({
    label: humaniseKey(key),
    node: toRenderTree(child),
  }))
  return { kind: 'entries', entries }
}
