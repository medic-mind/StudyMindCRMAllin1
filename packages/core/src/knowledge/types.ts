// Company knowledge base ("Protocols & Policies") — imported from the
// internal Crib site (ADR 0040). Pure types; no I/O.

/** Any JSON value inside the imported knowledge data. */
export type KnowledgeValue =
  | string
  | number
  | boolean
  | null
  | KnowledgeValue[]
  | { [key: string]: KnowledgeValue }

export type KnowledgeGroup =
  | 'Brands & products'
  | 'Packages & pricing'
  | 'Sales playbook'
  | 'Events & operations'
  | 'Reference'
  // Top-level keys added in-app (AI editor) that the imported baseline does
  // not know about land here, so nothing added can ever be invisible.
  | 'Custom'

export interface KnowledgeSectionDef {
  /** URL slug — the page lives at /protocols/<slug>. */
  slug: string
  /** Top-level key in the imported knowledge JSON this section renders. */
  dataKey: string
  title: string
  /** One-line description shown on the index card. */
  blurb: string
  group: KnowledgeGroup
}

/**
 * Display tree for a knowledge section. The imported data is arbitrary JSON;
 * `toRenderTree` reshapes it into these five node kinds so the UI renderer
 * and the plain-text serialiser share one structure.
 */
export type KnowledgeNode =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: KnowledgeNode[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'entries'; entries: KnowledgeEntry[] }
  | { kind: 'cards'; cards: KnowledgeCard[] }

export interface KnowledgeEntry {
  label: string
  node: KnowledgeNode
}

export interface KnowledgeCard {
  title: string | null
  node: KnowledgeNode
}

export interface KnowledgeSearchResult {
  sectionSlug: string
  sectionTitle: string
  /** Human-readable path inside the section, e.g. "Tiers › Platinum". */
  path: string
  /** Matched leaf text, trimmed around the first match. */
  snippet: string
  score: number
}

export interface KnowledgeContextSection {
  slug: string
  title: string
  score: number
}

export interface KnowledgeContext {
  /** Minified JSON object of the included sections, keyed by data key. */
  contextJson: string
  /** Sections included in the context, relevance-ordered. */
  included: KnowledgeContextSection[]
  /** Top-scoring sections — used by the UI as "read more" links. */
  related: KnowledgeContextSection[]
  /** True when the char budget forced sections to be dropped. */
  truncated: boolean
}

/**
 * The live knowledge base: the checked-in baseline, or the baseline with
 * in-app edits applied (a `KnowledgeOverride` row — ADR 0040). Everything
 * downstream (pages, search, AI context) reads from a store so edited and
 * baseline content flow through identical code.
 */
export interface KnowledgeStore {
  data: Readonly<Record<string, KnowledgeValue>>
  /** Manifest sections present in the data + auto-defs for added keys. */
  sections: readonly KnowledgeSectionDef[]
  /** Cache key — 'baseline' or the override row's updatedAt. */
  version: string
  /** True when an in-app edit (override row) is live. */
  edited: boolean
  /** When the override was last written; undefined for the baseline. */
  updatedAt?: Date
}

export type KnowledgePatchOp = 'replace' | 'add' | 'remove'

/**
 * One edit to the knowledge JSON, in the Crib AI-editor's dot-path format
 * (e.g. `fullApplication.tiers.3.hours`). Arrays use numeric indices;
 * `add` with an index equal to the array length (or `-`) appends.
 */
export interface KnowledgePatch {
  op: KnowledgePatchOp
  path: string
  value?: KnowledgeValue
}
