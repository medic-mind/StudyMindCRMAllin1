// Pure parsing / tokenisation of chat message bodies (ADR 0022).
//
// Client- AND server-safe: no I/O, no Node/Prisma runtime imports, so the
// browser renderer and the authoritative server-side extraction share exactly
// one grammar. Imported on the client via the `@studymind/core/chat/parse`
// subpath so none of the server-only chat code is pulled into the bundle.
//
// Grammar (Slack-inspired, stored verbatim in ChatMessage.body):
//   - User mention:  <@USERID>
//   - Entity ref:    <~TYPE:ID>   where TYPE ∈ contact | family | card | task
//   - Everything else is plain text. URLs, *bold*, _italic_ and `code` are
//     handled cosmetically by the renderer; they are not part of this grammar.

export const CHAT_REF_TYPES = ['contact', 'family', 'card', 'task'] as const
export type ChatRefType = (typeof CHAT_REF_TYPES)[number]

export interface ParsedRef {
  type: ChatRefType
  id: string
}

export type ChatToken =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string }
  | { kind: 'ref'; refType: ChatRefType; refId: string }

// Ids are cuid2 (lowercase alnum) but we accept the broader [A-Za-z0-9_-] set
// so seeded/legacy ids (e.g. `seed-chat-general`) round-trip cleanly.
const ID = '[A-Za-z0-9_-]+'
const MENTION_RE = new RegExp(`^<@(${ID})>$`)
const REF_RE = new RegExp(`^<~(contact|family|card|task):(${ID})>$`)
const TOKEN_RE = new RegExp(`<@${ID}>|<~(?:contact|family|card|task):${ID}>`, 'g')

/**
 * Split a stored body into an ordered list of text / mention / ref tokens.
 * Round-trips losslessly: joining the rendered pieces reproduces the input.
 */
export function tokenizeChatBody(body: string): ChatToken[] {
  const tokens: ChatToken[] = []
  let lastIndex = 0
  for (const match of body.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      tokens.push({ kind: 'text', text: body.slice(lastIndex, start) })
    }
    const raw = match[0]
    const mention = MENTION_RE.exec(raw)
    if (mention) {
      tokens.push({ kind: 'mention', userId: mention[1]! })
    } else {
      const ref = REF_RE.exec(raw)
      if (ref) {
        tokens.push({ kind: 'ref', refType: ref[1] as ChatRefType, refId: ref[2]! })
      }
    }
    lastIndex = start + raw.length
  }
  if (lastIndex < body.length) {
    tokens.push({ kind: 'text', text: body.slice(lastIndex) })
  }
  return tokens
}

/** Distinct mentioned user-ids, in first-seen order. */
export function extractMentionUserIds(body: string): string[] {
  const ids = new Set<string>()
  for (const token of tokenizeChatBody(body)) {
    if (token.kind === 'mention') ids.add(token.userId)
  }
  return [...ids]
}

/** Distinct entity references, in first-seen order (deduped by type+id). */
export function extractRefs(body: string): ParsedRef[] {
  const seen = new Set<string>()
  const refs: ParsedRef[] = []
  for (const token of tokenizeChatBody(body)) {
    if (token.kind !== 'ref') continue
    const key = `${token.refType}:${token.refId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ type: token.refType, id: token.refId })
  }
  return refs
}

/** Encode a user mention token for insertion into a draft. */
export function mentionToken(userId: string): string {
  return `<@${userId}>`
}

/** Encode an entity-reference token for insertion into a draft. */
export function refToken(type: ChatRefType, id: string): string {
  return `<~${type}:${id}>`
}

/**
 * Plain-text projection of a body with tokens replaced by readable labels.
 * Used for notification previews, the sidebar's "last message" line, and the
 * mention inbox — anywhere a single line of text is wanted instead of chips.
 * `names` maps an id (user or entity) to its display label.
 */
export function bodyToPlainText(body: string, names: Record<string, string> = {}): string {
  return tokenizeChatBody(body)
    .map((token) => {
      if (token.kind === 'text') return token.text
      if (token.kind === 'mention') return `@${names[token.userId] ?? 'someone'}`
      return `#${names[token.refId] ?? token.refType}`
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
}
