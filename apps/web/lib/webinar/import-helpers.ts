// Schedule import helpers: pull plain text out of an uploaded CSV / PDF / paste
// (dependency-free — PDFs are inflated with Node's built-in zlib), and a
// deterministic fallback parser for when the AI structurer is unavailable.

import zlib from 'node:zlib'

export type ImportKind = 'pdf' | 'csv' | 'text'

export interface ParsedWeek {
  weekNumber: number
  topic: string
}

/**
 * Best-effort PDF → text. Works for text-based PDFs (Word/Docs/Sheets exports):
 * inflate each content stream and pull the parenthesised text from the drawing
 * operators. Returns '' for scanned/image PDFs (caller then asks for CSV/paste).
 */
export function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1')
  const out: string[] = []
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(raw)) !== null) {
    const chunk = Buffer.from(m[1]!, 'latin1')
    let text = ''
    for (const decode of [tryInflate, tryInflateRaw, (b: Buffer) => b.toString('latin1')]) {
      const decoded = decode(chunk)
      if (decoded == null) continue
      const t = pullParenText(decoded)
      if (t.trim().length > 0) {
        text = t
        break
      }
    }
    if (text.trim().length > 0) out.push(text)
  }
  return out.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
}

function tryInflate(b: Buffer): string | null {
  try {
    return zlib.inflateSync(b).toString('latin1')
  } catch {
    return null
  }
}
function tryInflateRaw(b: Buffer): string | null {
  try {
    return zlib.inflateRawSync(b).toString('latin1')
  } catch {
    return null
  }
}

/** Pull text from PDF content: parenthesised literals, newlines on Td/TJ/T*. */
function pullParenText(content: string): string {
  const lines: string[] = []
  let current = ''
  // Tokenise just enough: (...) string literals and the operators that imply a
  // line break. We walk the string so escaped parens inside literals are safe.
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!
    if (ch === '(') {
      let s = ''
      i += 1
      let depth = 1
      while (i < content.length && depth > 0) {
        const c = content[i]!
        if (c === '\\') {
          s += content[i + 1] ?? ''
          i += 2
          continue
        }
        if (c === '(') depth += 1
        if (c === ')') {
          depth -= 1
          if (depth === 0) break
        }
        s += c
        i += 1
      }
      current += s
    } else if (content.startsWith('Td', i) || content.startsWith('TD', i) || content.startsWith('T*', i)) {
      if (current.trim()) lines.push(current.trim())
      current = ''
    }
  }
  if (current.trim()) lines.push(current.trim())
  return lines.join('\n')
}

/** Decode an uploaded file/paste to plain text for the importer. */
export function importToText(kind: ImportKind, opts: { base64?: string; text?: string }): string {
  if (kind === 'text') return (opts.text ?? '').trim()
  const buf = Buffer.from(opts.base64 ?? '', 'base64')
  if (kind === 'pdf') return extractPdfText(buf)
  // CSV (and any text/* upload): decode as UTF-8.
  return buf.toString('utf8').trim()
}

/**
 * Deterministic fallback parser. Splits the text into rows, strips leading
 * "Week N" / numbering / dates, and numbers the remaining topic lines 1..N.
 * Used when the AI structurer is unavailable or returns nothing.
 */
export function parseScheduleFallback(text: string, totalWeeks: number): ParsedWeek[] {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Drop obvious header rows.
    .filter((l) => !/^(week|topic|date|schedule|term)\b[\s,]*$/i.test(l))

  const weeks: ParsedWeek[] = []
  let auto = 0
  for (const row of rows) {
    if (weeks.length >= (totalWeeks || 60)) break
    // Split CSV-ish columns and prefer the longest cell as the topic.
    const cells = row.split(/[\t,;|]/).map((c) => c.trim()).filter(Boolean)
    const explicit = matchExplicitWeek(row)
    let topic = cells.length > 1 ? longestCell(cells) : row
    topic = stripWeekPrefix(stripLeadingDate(topic)).trim()
    if (!topic) continue
    auto += 1
    weeks.push({ weekNumber: explicit ?? auto, topic: topic.slice(0, 300) })
  }
  return weeks
}

function matchExplicitWeek(row: string): number | null {
  const m = /\bweek\s*(\d{1,2})\b/i.exec(row) ?? /^\s*(\d{1,2})[).:\-\s]/.exec(row)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 60 ? n : null
}

function longestCell(cells: string[]): string {
  return cells.reduce((a, b) => (b.length > a.length ? b : a), '')
}

function stripWeekPrefix(s: string): string {
  return s.replace(/^\s*(week\s*\d{1,2}|w\d{1,2})\b[).:\-\s]*/i, '').replace(/^\s*\d{1,2}[).:\-\s]+/, '')
}

function stripLeadingDate(s: string): string {
  return s.replace(
    /^\s*((mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?\d{1,2}(st|nd|rd|th)?[\s/\-.]+[a-z0-9]+([\s/\-.]+\d{2,4})?[\s,–-]*/i,
    '',
  )
}
