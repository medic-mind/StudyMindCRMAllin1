// The live knowledge store (ADR 0040). The checked-in baseline is the
// default; once the content has been edited in-app, the single
// `KnowledgeOverride` row (id = 'knowledge') is the live document. The
// store also derives the section list per document, so a top-level key
// added by the AI editor surfaces automatically (group "Custom") instead
// of vanishing behind the static manifest.

import { humaniseKey } from './render-tree'
import { getKnowledgeData, KNOWLEDGE_SECTIONS } from './sections'
import type { KnowledgeSectionDef, KnowledgeStore, KnowledgeValue } from './types'

export const KNOWLEDGE_OVERRIDE_ID = 'knowledge'

/** "campRefunds2027" → "camp-refunds2027" — a stable slug for added keys. */
function slugifyDataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function sectionsForData(
  data: Readonly<Record<string, KnowledgeValue>>,
): readonly KnowledgeSectionDef[] {
  const sections: KnowledgeSectionDef[] = KNOWLEDGE_SECTIONS.filter(
    (s) => data[s.dataKey] !== undefined,
  )
  const usedSlugs = new Set(sections.map((s) => s.slug))
  const manifestKeys = new Set(KNOWLEDGE_SECTIONS.map((s) => s.dataKey))

  for (const key of Object.keys(data)) {
    if (manifestKeys.has(key)) continue
    let slug = slugifyDataKey(key) || key
    while (usedSlugs.has(slug)) slug = `${slug}-custom`
    usedSlugs.add(slug)
    sections.push({
      slug,
      dataKey: key,
      title: humaniseKey(key),
      blurb: 'Added in-app — not part of the imported Crib baseline.',
      group: 'Custom',
    })
  }
  return sections
}

export interface BuildKnowledgeStoreInput {
  data: Readonly<Record<string, KnowledgeValue>>
  version: string
  edited: boolean
  updatedAt?: Date
}

export function buildKnowledgeStore(input: BuildKnowledgeStoreInput): KnowledgeStore {
  return {
    data: input.data,
    sections: sectionsForData(input.data),
    version: input.version,
    edited: input.edited,
    updatedAt: input.updatedAt,
  }
}

let baselineStore: KnowledgeStore | null = null

/** The checked-in baseline as a store (memoised — the data is static). */
export function baselineKnowledgeStore(): KnowledgeStore {
  if (!baselineStore) {
    baselineStore = buildKnowledgeStore({
      data: getKnowledgeData(),
      version: 'baseline',
      edited: false,
    })
  }
  return baselineStore
}

/** Minimal DB port — satisfied by PrismaClient. */
export interface KnowledgeDb {
  knowledgeOverride: {
    findUnique(args: {
      where: { id: string }
    }): Promise<{ data: unknown; updatedAt: Date } | null>
  }
}

function isKnowledgeDocument(
  value: unknown,
): value is Record<string, KnowledgeValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// One-slot cache: the override changes rarely and `updatedAt` versions it,
// so repeated page loads reuse the built store (and the search index keyed
// on store.version) without a stale-read risk.
let liveCache: { version: string; store: KnowledgeStore } | null = null

/** The LIVE knowledge base: override row if present, else the baseline. */
export async function loadKnowledgeStore(db: KnowledgeDb): Promise<KnowledgeStore> {
  const row = await db.knowledgeOverride.findUnique({
    where: { id: KNOWLEDGE_OVERRIDE_ID },
  })
  if (!row) return baselineKnowledgeStore()

  // A malformed row (must be a JSON object) cannot brick every knowledge
  // page — fall back to the baseline; `edit.status` still reports the row
  // so an admin can reset it.
  if (!isKnowledgeDocument(row.data)) return baselineKnowledgeStore()

  const version = `override:${row.updatedAt.toISOString()}`
  if (liveCache?.version === version) return liveCache.store
  const store = buildKnowledgeStore({
    data: row.data,
    version,
    edited: true,
    updatedAt: row.updatedAt,
  })
  liveCache = { version, store }
  return store
}

export function getKnowledgeSection(
  store: KnowledgeStore,
  slug: string,
): KnowledgeSectionDef | undefined {
  return store.sections.find((s) => s.slug === slug)
}

/** The raw data behind one section of a store, or undefined when unknown. */
export function getKnowledgeSectionData(
  store: KnowledgeStore,
  slug: string,
): KnowledgeValue | undefined {
  const section = getKnowledgeSection(store, slug)
  if (!section) return undefined
  return store.data[section.dataKey]
}
