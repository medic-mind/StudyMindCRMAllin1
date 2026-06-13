// Slack mention → contact matching (ADR 0034). The implementation now lives in
// @studymind/core (packages/core/src/contact/match-candidate.ts) so Slack
// archival, the Call Summaries entry point, and any future candidate resolver
// all share ONE matcher. Re-exported here to preserve the existing import
// path used by jobs.ts / backfill.ts.

export {
  matchContactByCandidate,
  phoneVariants,
  extractIdentifiersFromText,
  type MatchCandidate,
  type MatchContactRow,
  type MatchDb,
  type MatchVia,
  type MatchOutcome,
} from '@studymind/core/contact/match-candidate'
