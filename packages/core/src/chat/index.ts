// Internal team messaging domain (ADR 0022). Slack-style staff chat: channels,
// DMs, threaded messages, @mentions, reactions, and inline CRM-entity refs.
//
// NOTE: parse.ts is intentionally NOT re-exported here — it is the only
// client-safe module and is imported directly via `@studymind/core/chat/parse`
// so the browser bundle never pulls in Prisma-touching server code.

export const CHAT_DOMAIN = 'chat' as const

export * from './ctx'
export * from './types'
export * from './channels'
export * from './messages'
export * from './read-state'
export * from './mentions'
export {
  resolveRefs,
  searchRefTargets,
  type RefSearchResult,
} from './refs'
