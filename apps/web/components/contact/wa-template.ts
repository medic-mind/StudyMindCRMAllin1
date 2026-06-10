// Pure helpers for composing a Trengo WhatsApp (HSM) template "just as it
// would look on Trengo": the template body is split into static text and
// {{n}} placeholder slots so the UI can render the real message with inline
// fill-in fields at the exact placeholder positions. Logic only — no React —
// so it stays unit-testable.

export type WaTemplateSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'param'
      /** Normalised placeholder key, e.g. "{{1}}". */
      key: string
      /**
       * True for the first appearance of this key in the body — that's where
       * the UI renders the editable field. Later appearances mirror the typed
       * value read-only (WhatsApp substitutes every occurrence identically).
       */
      first: boolean
    }

const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g

/** Split a template body into static text + placeholder slots, in order. */
export function parseWaTemplateSegments(body: string): WaTemplateSegment[] {
  const segments: WaTemplateSegment[] = []
  const seen = new Set<string>()
  let cursor = 0
  for (const match of body.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0
    if (start > cursor) {
      segments.push({ kind: 'text', text: body.slice(cursor, start) })
    }
    const key = `{{${match[1]}}}`
    segments.push({ kind: 'param', key, first: !seen.has(key) })
    seen.add(key)
    cursor = start + match[0].length
  }
  if (cursor < body.length) {
    segments.push({ kind: 'text', text: body.slice(cursor) })
  }
  return segments
}

/** Render the body with the typed values. Unfilled params keep their {{n}}
 *  placeholder so previews (and send guards) stay honest. */
export function renderWaTemplate(body: string, params: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (whole, n: string) => {
    const v = params[`{{${n}}}`]
    return v && v.trim().length > 0 ? v : whole
  })
}

/** The param keys still missing a value — WhatsApp rejects an HSM with empty
 *  params, so the wizard blocks sending until this is empty. */
export function missingWaParams(
  paramKeys: ReadonlyArray<string>,
  values: Record<string, string>,
): string[] {
  return paramKeys.filter((key) => !(values[key] ?? '').trim())
}
