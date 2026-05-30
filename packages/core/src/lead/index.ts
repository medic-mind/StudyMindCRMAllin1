// @studymind/core/lead — dynamic lead ingestion + classification (ADR 0023).
// Pure domain logic: normalise any form payload, classify it (brand / products
// / categories / score), and decide contact-matching + re-enquiry dedupe. All
// I/O (DB reads, AI calls, pipeline routing) lives in the packages/jobs
// processor that consumes these.

export * from './types'
export { normaliseLead, normalisePhone, type RawLeadInput } from './normalise'
export { classifyLead, type ClassifyOptions } from './classify'
export { scoreLead, type ScoreSignals, type ScoreResult } from './score'
export {
  chooseContactMatch,
  shouldCreateCardOnReenquiry,
  planLeadRouting,
  type ContactCandidate,
  type MatchDecision,
  type LeadRoutingPlan,
} from './match'
