// Visual renderer for the imported knowledge base (ADR 0040). Operates on
// the RAW knowledge JSON so it can shape each piece of content by meaning:
// pricing as a clean rate list, glossaries as a definition list, tiers and
// products as quiet cards, processes as numbered steps. The aesthetic is
// deliberately editorial and near-monochrome — typography, whitespace and
// hairline rules do the work; colour is reserved for the page chrome, not
// smeared through the body. Heuristics are pure + unit-tested in
// `@/lib/knowledge/present`. CLAUDE.md §4 (calm, brand-forward, no emoji),
// §26 (RSC presentational), §28 (real tables are <table>).

import type { KnowledgeValue } from '@studymind/core/knowledge'
import { humaniseKey } from '@studymind/core/knowledge'

import { CheckIcon } from '@/components/ui/icon'
import {
  anchorId,
  asGlossaryRecord,
  asRecordGrid,
  asStatRecord,
  cardParts,
  classifyArray,
  extractSummary,
  isIncludesKey,
  isObject,
  isScalar,
  isStepKey,
  looksLikeStat,
  partitionEntries,
  scalarText,
  type KnowledgeObject,
  type Scalar,
} from '@/lib/knowledge/present'

// ── Leaf renderers ───────────────────────────────────────────────────────

function Prose({ text }: { text: string }) {
  return <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-600">{text}</p>
}

/** A small label above a block of nested content (e.g. "Split", "Includes"). */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
      {children}
    </p>
  )
}

function Chips({ items }: { items: Scalar[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, idx) => (
        <span
          key={idx}
          className="inline-flex items-center rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-xs text-neutral-600"
        >
          {scalarText(item)}
        </span>
      ))}
    </div>
  )
}

/** "Included" feature lists — a quiet checklist (the check carries meaning). */
function Checklist({ items }: { items: Scalar[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, idx) => (
        <li key={idx} className="flex gap-2 text-sm leading-relaxed text-neutral-600">
          <CheckIcon size={14} className="mt-0.5 shrink-0 text-neutral-400" />
          <span className="whitespace-pre-line">{scalarText(item)}</span>
        </li>
      ))}
    </ul>
  )
}

function Bullets({ items, depth }: { items: KnowledgeValue[]; depth: number }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-neutral-300">
      {items.map((item, idx) => (
        <li key={idx} className="pl-1 text-sm leading-relaxed text-neutral-600">
          {isScalar(item) ? (
            <span className="whitespace-pre-line">{scalarText(item)}</span>
          ) : (
            <KnowledgeValueView value={item} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  )
}

/** Sequential guidance (scenario steps, processes) — numbered, not bulleted. */
function Steps({ items }: { items: Scalar[] }) {
  return (
    <ol className="space-y-2.5">
      {items.map((item, idx) => (
        <li key={idx} className="flex gap-3">
          <span
            aria-hidden
            className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[11px] font-semibold tabular-nums text-neutral-500"
          >
            {idx + 1}
          </span>
          <span className="whitespace-pre-line text-sm leading-relaxed text-neutral-600">
            {scalarText(item)}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** Rate-card list for {label, value, notes} records — clean rows, no tiles. */
function StatList({ items }: { items: KnowledgeObject[] }) {
  const stats = items.map((o) => asStatRecord(o)).filter((s): s is NonNullable<typeof s> => !!s)
  return (
    <dl className="divide-y divide-neutral-100">
      {stats.map((stat, idx) => (
        <div
          key={idx}
          className="grid grid-cols-1 gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1fr,auto]"
        >
          <dt>
            <span className="text-sm font-medium text-neutral-800">{stat.label}</span>
            {stat.note ? (
              <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{stat.note}</p>
            ) : null}
          </dt>
          <dd className="text-sm font-semibold tabular-nums text-neutral-900 sm:text-right">
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Glossary / FAQ — a clean definition list, two columns on wide screens. */
function GlossaryList({ items }: { items: KnowledgeObject[] }) {
  const defs = items
    .map((o) => asGlossaryRecord(o))
    .filter((d): d is NonNullable<typeof d> => !!d)
  return (
    <dl className="grid gap-x-10 gap-y-5 md:grid-cols-2">
      {defs.map((def, idx) => (
        <div key={idx}>
          <dt className="text-sm font-semibold text-neutral-900">{def.term}</dt>
          <dd className="mt-1 text-sm leading-relaxed text-neutral-600">{def.definition}</dd>
        </div>
      ))}
    </dl>
  )
}

function DataTable({ items }: { items: KnowledgeObject[] }) {
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
          <tr className="border-b border-neutral-200 text-left">
            {columns.map((col) => (
              <th
                key={col}
                scope="col"
                className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400"
              >
                {humaniseKey(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {items.map((obj, rowIdx) => (
            <tr key={rowIdx}>
              {columns.map((col) => {
                const text = cell(obj[col])
                const numeric = looksLikeStat(text)
                return (
                  <td
                    key={col}
                    className={`px-3 py-2 align-top leading-relaxed ${
                      numeric ? 'tabular-nums text-neutral-900' : 'text-neutral-600'
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

/** Two-column caption · value list for an object's scalar fields. */
function DefinitionGrid({ entries }: { entries: Array<[string, Scalar]> }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
      {entries.map(([key, value]) => {
        const text = scalarText(value)
        const numeric = looksLikeStat(text)
        return (
          <div key={key}>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              {humaniseKey(key)}
            </dt>
            <dd
              className={`mt-0.5 whitespace-pre-line text-sm leading-relaxed ${
                numeric ? 'font-medium tabular-nums text-neutral-900' : 'text-neutral-700'
              }`}
            >
              {text}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** A quiet record card — a title row with small neutral badges, then fields. */
function RecordCard({
  obj,
  depth,
  fallbackTitle,
  id,
}: {
  obj: KnowledgeObject
  depth: number
  fallbackTitle?: string | null
  id?: string
}) {
  const { title, badges, rest } = cardParts(obj, fallbackTitle)
  return (
    <div id={id} className="scroll-mt-6 overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-neutral-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-neutral-900">{title ?? 'Item'}</h3>
        {badges.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {badges.map(([label, value]) => (
              <span
                key={label}
                className="rounded-md bg-neutral-100 px-2 py-0.5 text-[11px] font-medium tabular-nums text-neutral-600"
              >
                <span className="font-normal text-neutral-400">{label} </span>
                {value}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {Object.keys(rest).length > 0 ? (
        <div className="px-4 py-3.5">
          <ObjectView obj={rest} depth={depth + 1} />
        </div>
      ) : null}
    </div>
  )
}

// ── Array + object dispatchers ─────────────────────────────────────────────

function ArrayView({
  items,
  depth,
  hint,
}: {
  items: KnowledgeValue[]
  depth: number
  hint?: string
}) {
  const layout = classifyArray(items)
  if ((layout === 'chips' || layout === 'bullets') && isStepKey(hint)) {
    return <Steps items={items as Scalar[]} />
  }
  if ((layout === 'chips' || layout === 'bullets') && isIncludesKey(hint)) {
    return <Checklist items={items as Scalar[]} />
  }
  switch (layout) {
    case 'empty':
      return <p className="text-sm text-neutral-400">None.</p>
    case 'chips':
      return <Chips items={items as Scalar[]} />
    case 'bullets':
      return <Bullets items={items} depth={depth} />
    case 'stats':
      return <StatList items={items as KnowledgeObject[]} />
    case 'glossary':
      return <GlossaryList items={items as KnowledgeObject[]} />
    case 'table':
      return <DataTable items={items as KnowledgeObject[]} />
    case 'cards':
      return (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {(items as KnowledgeObject[]).map((obj, idx) => (
            <RecordCard key={idx} obj={obj} depth={depth} />
          ))}
        </div>
      )
    case 'blocks':
      return (
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={idx} className="rounded-lg border border-neutral-200 bg-white p-3.5">
              <KnowledgeValueView value={item} depth={depth + 1} />
            </div>
          ))}
        </div>
      )
  }
}

function ObjectView({ obj, depth }: { obj: KnowledgeObject; depth: number }) {
  const { scalars, complex } = partitionEntries(obj)
  return (
    <div className="space-y-5">
      {scalars.length > 0 ? <DefinitionGrid entries={scalars} /> : null}
      {complex.map(([key, value]) => (
        <section key={key}>
          <FieldLabel>{humaniseKey(key)}</FieldLabel>
          <KnowledgeValueView value={value} depth={depth + 1} hint={key} />
        </section>
      ))}
    </div>
  )
}

/** Recursive value dispatcher. */
export function KnowledgeValueView({
  value,
  depth,
  hint,
}: {
  value: KnowledgeValue
  depth: number
  hint?: string
}) {
  if (isScalar(value)) return <Prose text={scalarText(value)} />
  if (Array.isArray(value)) return <ArrayView items={value} depth={depth} hint={hint} />
  return <ObjectView obj={value} depth={depth} />
}

// ── Section entry point ────────────────────────────────────────────────────

/**
 * Renders a whole section's raw data as an editorial page: a lead summary,
 * a definition grid for top-level facts, then each remaining key as a
 * headed block separated by whitespace + a hairline rule. Catalogue
 * sections (products, hubs, brands) render as a quiet card grid. The body
 * is deliberately monochrome — colour lives in the page chrome only.
 */
export function KnowledgeNodeView({ data }: { data: KnowledgeValue }) {
  if (isObject(data)) {
    const { summary, rest } = extractSummary(data)
    const { scalars, complex } = partitionEntries(rest)
    const grid = asRecordGrid(complex)

    return (
      <div className="space-y-8">
        {summary ? (
          <p className="max-w-3xl text-[15px] leading-relaxed text-neutral-600">{summary}</p>
        ) : null}

        {scalars.length > 0 ? <DefinitionGrid entries={scalars} /> : null}

        {grid ? (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {grid.map(([key, obj]) => (
              <RecordCard
                key={key}
                id={anchorId(key)}
                obj={obj}
                depth={1}
                fallbackTitle={humaniseKey(key)}
              />
            ))}
          </div>
        ) : (
          complex.map(([key, value]) => (
            <section
              key={key}
              id={anchorId(key)}
              className="scroll-mt-6 border-t border-neutral-200 pt-7"
            >
              <h2 className="mb-4 text-base font-semibold tracking-tight text-neutral-900">
                {humaniseKey(key)}
              </h2>
              <KnowledgeValueView value={value} depth={1} hint={key} />
            </section>
          ))
        )}
      </div>
    )
  }

  // Top-level array (glossary, FAQ, scenarios…) or scalar — render open.
  return <KnowledgeValueView value={data} depth={0} />
}
