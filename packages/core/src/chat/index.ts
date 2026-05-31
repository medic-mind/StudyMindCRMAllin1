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
export * from './search'
export * from './pins'
export * from './saves'
export {
  resolveRefs,
  searchRefTargets,
  type RefSearchResult,
} from './refs'
// NOTE: S3 attachment storage (`./s3`) is deliberately NOT re-exported here — it
// imports the AWS SDK at module top level, and this barrel is reachable from
// client components (which pull `CHAT_REACTION_EMOJI` etc). Server callers reach
// it via the dedicated `@studymind/core/chat/s3` subpath, mirroring the Trengo
// attachment module.
