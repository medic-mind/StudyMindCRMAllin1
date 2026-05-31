// Composer draft → stored-body conversion (ADR 0022). Pure + client-safe.
//
// The composer textarea holds human-readable text: a mention reads "@Alex Doe"
// and a reference reads "#Smith Family". We track each inserted token's exact
// marker string alongside its id, then convert markers → storage tokens
// (`<@id>` / `<~type:id>`) on send. Longest markers are replaced first so
// "@Alex" never shadows "@Alex Doe", and each marker is consumed once (in
// insertion order) so duplicate names resolve deterministically.

import { mentionToken, refToken, type ChatRefType } from '@studymind/core/chat/parse'

export interface DraftMention {
  marker: string
  userId: string
}

export interface DraftRef {
  marker: string
  type: ChatRefType
  id: string
}

/** Replace the first not-yet-consumed occurrence of `marker` in `text`. */
function replaceFirst(text: string, marker: string, replacement: string): string {
  const idx = text.indexOf(marker)
  if (idx < 0) return text
  return text.slice(0, idx) + replacement + text.slice(idx + marker.length)
}

/**
 * Build the stored body from the draft text and its tracked mentions/refs.
 * Markers that the user has since edited away simply stay as literal text — the
 * server treats anything that is not a token as plain text.
 */
export function composeBody(
  text: string,
  mentions: ReadonlyArray<DraftMention>,
  refs: ReadonlyArray<DraftRef>,
): string {
  let body = text

  const mentionByLength = [...mentions].sort((a, b) => b.marker.length - a.marker.length)
  for (const m of mentionByLength) {
    body = replaceFirst(body, m.marker, mentionToken(m.userId))
  }

  const refByLength = [...refs].sort((a, b) => b.marker.length - a.marker.length)
  for (const r of refByLength) {
    body = replaceFirst(body, r.marker, refToken(r.type, r.id))
  }

  return body.trim()
}

/**
 * The active "@" query immediately before the caret, or null. Triggers the
 * mention autocomplete: matches an "@" preceded by start-or-whitespace, then
 * up to ~40 non-newline chars with no second "@".
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const upToCaret = text.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]{0,40})$/u.exec(upToCaret)
  if (!match) return null
  const query = match[1] ?? ''
  return { query, start: caret - query.length - 1 }
}
