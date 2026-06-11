// Plain-text extraction for HTML message bodies (Trengo email channel,
// imported email history). Email bodies arrive as raw HTML; rendering them
// verbatim shows tag soup, and injecting them into the DOM unsanitised is an
// XSS hole (CLAUDE.md §44). We deliberately render readable TEXT, not rich
// HTML — no third-party sanitiser dependency without an ADR.

const BLOCK_END = /<\/(?:p|div|tr|table|h[1-6]|blockquote|pre|section|article)\s*>/gi
const LINE_BREAK = /<br\s*\/?>/gi
const LIST_ITEM = /<li[^>]*>/gi
const DROP_WITH_CONTENT = /<(script|style|head|title)[^>]*>[\s\S]*?<\/\1\s*>/gi
const ANY_TAG = /<\/?[a-z!][^>]*>/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  pound: '£',
  copy: '©',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

/** Cheap check: does this body need HTML extraction at all? */
export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(s) || /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i.test(s)
}

/**
 * Convert an HTML email body to readable plain text: block ends and <br>
 * become newlines, list items become bullets, script/style vanish with
 * their content, every other tag is stripped, entities decode, and runs of
 * blank lines collapse. Idempotent on already-plain text.
 */
export function htmlToText(s: string): string {
  return decodeEntities(
    s
      .replace(DROP_WITH_CONTENT, '')
      .replace(LINE_BREAK, '\n')
      .replace(LIST_ITEM, '\n• ')
      .replace(BLOCK_END, '\n')
      .replace(ANY_TAG, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Render a message body for display: HTML becomes readable text, plain
 *  text passes through untouched. */
export function displayMessageBody(body: string | null): string | null {
  if (body === null) return null
  return looksLikeHtml(body) ? htmlToText(body) : body
}
