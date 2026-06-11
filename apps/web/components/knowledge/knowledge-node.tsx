// Visual renderer for the imported knowledge base (ADR 0040). Operates on
// the RAW knowledge JSON (not the search/plain-text render tree) so it can
// be genuinely visual — pricing renders as stat tiles, glossaries as
// definition cards, tiers as badged cards with chip lists, flat records as
// styled tables. The display heuristics are pure + unit-tested in
// `@/lib/knowledge/present`. CLAUDE.md §4 (brand-forward, no emoji), §26
// (RSC presentational), §28 (real tables are <table>).

import type { KnowledgeValue } from '@studymind/core/knowledge'
import { humaniseKey } from '@studymind/core/knowledge'

import { CheckIcon } from '@/components/ui/icon'
import {
  asGlossaryRecord,
  asStatRecord,
  classifyArray,
  extractSummary,
  isObject,
  isScalar,
  looksLikeStat,
  partitionEntries,
  pickTitleKey,
  scalarText,
  type KnowledgeObject,
  type Scalar,
} from '@/lib/knowledge/present'

// ── Tone system (per section group) ─────────────────────────────────────
export type KnowledgeTone =
  | 'brand'
  | 'pricing'
  | 'playbook'
  | 'events'
  | 'reference'
  | 'neutral'

interface ToneClasses {
  bar: string
  heading: string
  chip: string
  statBar: string
  statValue: string
  summaryBg: string
  summaryBorder: string
  marker: string
}

const TONES: Record<KnowledgeTone, ToneClasses> = {
  brand: {
    bar: 'bg-primary-500',
    heading: 'text-primary-700',
    chip: 'bg-primary-50 text-primary-700 border-primary-100',
    statBar: 'bg-primary-500',
    statValue: 'text-primary-700',
    summaryBg: 'bg-primary-50/60',
    summaryBorder: 'border-primary-100',
    marker: 'marker:text-primary-400',
  },
  pricing: {
    bar: 'bg-emerald-500',
    heading: 'text-emerald-700',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    statBar: 'bg-emerald-500',
    statValue: 'text-emerald-700',
    summaryBg: 'bg-emerald-50/60',
    summaryBorder: 'border-emerald-100',
    marker: 'marker:text-emerald-400',
  },
  playbook: {
    bar: 'bg-amber-500',
    heading: 'text-amber-700',
    chip: 'bg-amber-50 text-amber-700 border-amber-100',
    statBar: 'bg-amber-500',
    statValue: 'text-amber-700',
    summaryBg: 'bg-amber-50/60',
    summaryBorder: 'border-amber-100',
    marker: 'marker:text-amber-400',
  },
  events: {
    bar: 'bg-sky-500',
    heading: 'text-sky-700',
    chip: 'bg-sky-50 text-sky-700 border-sky-100',
    statBar: 'bg-sky-500',
    statValue: 'text-sky-700',
    summaryBg: 'bg-sky-50/60',
    summaryBorder: 'border-sky-100',
    marker: 'marker:text-sky-400',
  },
  reference: {
    bar: 'bg-violet-500',
    heading: 'text-violet-700',
    chip: 'bg-violet-50 text-violet-700 border-violet-100',
    statBar: 'bg-violet-500',
    statValue: 'text-violet-700',
    summaryBg: 'bg-violet-50/60',
    summaryBorder: 'border-violet-100',
    marker: 'marker:text-violet-400',
  },
  neutral: {
    bar: 'bg-neutral-400',
    heading: 'text-neutral-700',
    chip: 'bg-neutral-100 text-neutral-700 border-neutral-200',
    statBar: 'bg-neutral-400',
    statValue: 'text-neutral-800',
    summaryBg: 'bg-neutral-50',
    summaryBorder: 'border-neutral-200',
    marker: 'marker:text-neutral-400',
  },
}

// ── Leaf renderers ───────────────────────────────────────────────────────

function Prose({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-700">{text}</p>
  )
}

function Chips({ items, tone }: { items: Scalar[]; tone: ToneClasses }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, idx) => (
        <span
          key={idx}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${tone.chip}`}
        >
          <CheckIcon size={12} className="opacity-60" />
          {scalarText(item)}
        </span>
      ))}
    </div>
  )
}

function Bullets({
  items,
  tone,
  depth,
}: {
  items: KnowledgeValue[]
  tone: ToneClasses
  depth: number
}) {
  return (
    <ul className={`list-disc space-y-1.5 pl-5 ${tone.marker}`}>
      {items.map((item, idx) => (
        <li key={idx} className="pl-1 text-sm leading-relaxed text-neutral-700">
          {isScalar(item) ? (
            <span className="whitespace-pre-line">{scalarText(item)}</span>
          ) : (
            <KnowledgeValueView value={item} tone={tone} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  )
}

function StatGrid({ items, tone }: { items: KnowledgeObject[]; tone: ToneClasses }) {
  const stats = items.map((o) => asStatRecord(o)).filter((s): s is NonNullable<typeof s> => !!s)
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {stats.map((stat, idx) => (
        <div
          key={idx}
          className="relative overflow-hidden rounded-xl border border-neutral-200 bg-white p-4 pl-5 shadow-sm"
        >
          <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${tone.statBar}`} />
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            {stat.label}
          </p>
          <p className={`mt-1.5 font-mono text-xl font-semibold tabular-nums ${tone.statValue}`}>
            {stat.value}
          </p>
          {stat.note ? (
            <p className="mt-1.5 text-xs leading-relaxed text-neutral-500">{stat.note}</p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function GlossaryGrid({ items, tone }: { items: KnowledgeObject[]; tone: ToneClasses }) {
  const defs = items
    .map((o) => asGlossaryRecord(o))
    .filter((d): d is NonNullable<typeof d> => !!d)
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {defs.map((def, idx) => (
        <div key={idx} className="rounded-lg border border-neutral-200 bg-white p-4">
          <h4 className={`text-sm font-semibold ${tone.heading}`}>{def.term}</h4>
          <p className="mt-1 text-sm leading-relaxed text-neutral-600">{def.definition}</p>
        </div>
      ))}
    </div>
  )
}

function DataTable({ items, tone }: { items: KnowledgeObject[]; tone: ToneClasses }) {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const obj of items) {
    for (const key of Object.keys(obj)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  const cell = (value: KnowledgeValue | undefined): string => {
    if (value === undefined) return '—'
    if (isScalar(value)) return scalarText(value)
    if (Array.isArray(value)) return value.map((v) => scalarText(v as Scalar)).join(', ')
    return '—'
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-neutral-50 text-left">
            {columns.map((col) => (
              <th
                key={col}
                scope="col"
                className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500"
              >
                {humaniseKey(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((obj, rowIdx) => (
            <tr key={rowIdx} className="border-t border-neutral-100 odd:bg-white even:bg-neutral-50/40">
              {columns.map((col) => {
                const text = cell(obj[col])
                const stat = looksLikeStat(text)
                return (
                  <td
                    key={col}
                    className={`px-3 py-2 align-top leading-relaxed ${
                      stat
                        ? `font-mono tabular-nums font-medium ${tone.statValue}`
                        : 'text-neutral-700'
                    }`}
                  >
                    {text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A definition grid for an object's scalar entries: label · value. */
function DefinitionGrid({
  entries,
  tone,
}: {
  entries: Array<[string, Scalar]>
  tone: ToneClasses
}) {
  return (
    <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
      {entries.map(([key, value]) => {
        const text = scalarText(value)
        const stat = looksLikeStat(text)
        return (
          <div key={key} className="flex flex-col gap-0.5 border-b border-neutral-100 pb-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              {humaniseKey(key)}
            </dt>
            <dd
              className={
                stat
                  ? `font-mono text-base font-semibold tabular-nums ${tone.statValue}`
                  : 'whitespace-pre-line text-sm leading-relaxed text-neutral-700'
              }
            >
              {text}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** A rich "record card" — a title row with numeric badges, then its fields. */
function RecordCard({
  obj,
  tone,
  depth,
}: {
  obj: KnowledgeObject
  tone: ToneClasses
  depth: number
}) {
  const titleKey = pickTitleKey(obj)
  const title = titleKey ? scalarText(obj[titleKey] as Scalar) : null

  // Surface short numeric/stat scalar fields as header badges.
  const badges: Array<[string, string]> = []
  const rest: KnowledgeObject = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === titleKey) continue
    if (isScalar(value)) {
      const text = scalarText(value)
      if (looksLikeStat(text) && badges.length < 4) {
        badges.push([humaniseKey(key), text])
        continue
      }
    }
    rest[key] = value
  }

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 bg-neutral-50/60 px-4 py-2.5">
        <h4 className={`text-sm font-semibold ${title ? tone.heading : 'text-neutral-700'}`}>
          {title ?? 'Item'}
        </h4>
        {badges.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {badges.map(([label, value]) => (
              <span
                key={label}
                className="inline-flex items-baseline gap-1 rounded-md border border-neutral-200 bg-white px-2 py-0.5"
              >
                <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                  {label}
                </span>
                <span className={`font-mono text-xs font-semibold tabular-nums ${tone.statValue}`}>
                  {value}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {Object.keys(rest).length > 0 ? (
        <div className="px-4 py-3">
          <ObjectView obj={rest} tone={tone} depth={depth + 1} />
        </div>
      ) : null}
    </div>
  )
}

// ── Array + object dispatchers ─────────────────────────────────────────────

function ArrayView({
  items,
  tone,
  depth,
}: {
  items: KnowledgeValue[]
  tone: ToneClasses
  depth: number
}) {
  const layout = classifyArray(items)
  switch (layout) {
    case 'empty':
      return <p className="text-sm text-neutral-400">None.</p>
    case 'chips':
      return <Chips items={items as Scalar[]} tone={tone} />
    case 'bullets':
      return <Bullets items={items} tone={tone} depth={depth} />
    case 'stats':
      return <StatGrid items={items as KnowledgeObject[]} tone={tone} />
    case 'glossary':
      return <GlossaryGrid items={items as KnowledgeObject[]} tone={tone} />
    case 'table':
      return <DataTable items={items as KnowledgeObject[]} tone={tone} />
    case 'cards':
      return (
        <div className="grid gap-3 lg:grid-cols-2">
          {(items as KnowledgeObject[]).map((obj, idx) => (
            <RecordCard key={idx} obj={obj} tone={tone} depth={depth} />
          ))}
        </div>
      )
    case 'blocks':
      return (
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={idx} className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-3">
              <KnowledgeValueView value={item} tone={tone} depth={depth + 1} />
            </div>
          ))}
        </div>
      )
  }
}

function ObjectView({
  obj,
  tone,
  depth,
}: {
  obj: KnowledgeObject
  tone: ToneClasses
  depth: number
}) {
  const { scalars, complex } = partitionEntries(obj)
  return (
    <div className="space-y-4">
      {scalars.length > 0 ? <DefinitionGrid entries={scalars} tone={tone} /> : null}
      {complex.map(([key, value]) => (
        <section key={key}>
          <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            <span aria-hidden className={`h-3 w-1 rounded-full ${tone.bar}`} />
            {humaniseKey(key)}
          </h4>
          <KnowledgeValueView value={value} tone={tone} depth={depth + 1} />
        </section>
      ))}
    </div>
  )
}

/** Recursive value dispatcher. */
export function KnowledgeValueView({
  value,
  tone,
  depth,
}: {
  value: KnowledgeValue
  tone: ToneClasses
  depth: number
}) {
  if (isScalar(value)) return <Prose text={scalarText(value)} />
  if (Array.isArray(value)) return <ArrayView items={value} tone={tone} depth={depth} />
  return <ObjectView obj={value} tone={tone} depth={depth} />
}

// ── Section entry point ────────────────────────────────────────────────────

/**
 * Renders a whole section's raw data with the group's accent tone. A
 * top-level object gets its lead summary lifted into an accent panel and
 * each remaining key rendered as its own titled card; arrays + scalars
 * render directly. This is what the section page mounts.
 */
export function KnowledgeNodeView({
  data,
  tone = 'neutral',
}: {
  data: KnowledgeValue
  tone?: KnowledgeTone
}) {
  const t = TONES[tone]

  if (isObject(data)) {
    const { summary, rest } = extractSummary(data)
    const { scalars, complex } = partitionEntries(rest)
    return (
      <div className="space-y-5">
        {summary ? (
          <div className={`rounded-xl border ${t.summaryBorder} ${t.summaryBg} px-4 py-3`}>
            <p className="text-sm leading-relaxed text-neutral-700">{summary}</p>
          </div>
        ) : null}

        {scalars.length > 0 ? (
          <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-5">
            <DefinitionGrid entries={scalars} tone={t} />
          </div>
        ) : null}

        {complex.map(([key, value]) => (
          <section key={key} className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
            <div className="flex items-center gap-2.5 border-b border-neutral-100 px-4 py-3 sm:px-5">
              <span aria-hidden className={`h-5 w-1.5 rounded-full ${t.bar}`} />
              <h3 className="text-base font-semibold text-neutral-900">{humaniseKey(key)}</h3>
            </div>
            <div className="px-4 py-4 sm:px-5">
              <KnowledgeValueView value={value} tone={t} depth={1} />
            </div>
          </section>
        ))}
      </div>
    )
  }

  // Top-level array (glossary, FAQ, scenarios…) or scalar.
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-5">
      <KnowledgeValueView value={data} tone={t} depth={0} />
    </div>
  )
}
