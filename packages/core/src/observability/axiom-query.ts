// Thin wrapper around Axiom's APL query API. CLAUDE.md §25.1, Slice 14.
//
// Outbound HTTP through safeFetch (CLAUDE.md §44.2). Reads
// AXIOM_TOKEN and AXIOM_DATASET from env. The query API is minimal —
// we POST APL text and a time range; Axiom returns rows.
//
// Tests inject a fake `fetchImpl` so we never hit the real API.

import { safeFetch } from './safe-fetch'

export const AXIOM_QUERY_URL = 'https://api.axiom.co/v1/datasets/_apl' as const

export interface AxiomQueryInput {
  apl: string
  startTime: Date
  endTime: Date
  fetchImpl?: typeof fetch
  token?: string
}

export interface AxiomQueryRow {
  [k: string]: unknown
}

export interface AxiomQueryResult {
  rows: AxiomQueryRow[]
}

export async function queryAxiom(input: AxiomQueryInput): Promise<AxiomQueryResult> {
  const token = input.token ?? process.env['AXIOM_TOKEN']
  if (!token) throw new Error('AXIOM_TOKEN is not configured')
  const fetchImpl = input.fetchImpl ?? safeFetch

  const body = {
    apl: input.apl,
    startTime: input.startTime.toISOString(),
    endTime: input.endTime.toISOString(),
  }
  const res = await fetchImpl(`${AXIOM_QUERY_URL}?format=tabular`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Axiom query failed: ${res.status} ${text}`)
  }
  // Axiom returns either { matches: [{ data: {...} }] } or a tabular payload.
  // We normalise to a flat row list.
  const data = (await res.json()) as {
    matches?: Array<{ data?: AxiomQueryRow }>
    tables?: Array<{ columns?: Array<{ name: string }>; rows?: unknown[][] }>
  }
  const rows: AxiomQueryRow[] = []
  if (data.matches) {
    for (const m of data.matches) {
      if (m.data) rows.push(m.data)
    }
  }
  if (data.tables) {
    for (const t of data.tables) {
      const cols = (t.columns ?? []).map((c) => c.name)
      for (const r of t.rows ?? []) {
        const row: AxiomQueryRow = {}
        for (let i = 0; i < cols.length; i++) {
          row[cols[i] as string] = r[i]
        }
        rows.push(row)
      }
    }
  }
  return { rows }
}
