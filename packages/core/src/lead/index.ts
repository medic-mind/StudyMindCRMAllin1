// @studymind/core/lead — dynamic lead ingestion + classification (ADR 0023).
// Pure domain logic: normalise any form payload, classify it (brand / products
// / categories / score), and decide contact-matching + re-enquiry dedupe. All
// I/O (DB reads, AI calls, pipeline routing) lives in the packages/jobs
// processor that consumes these.

export * from './types'
export { normaliseLead, normalisePhone, extractPreferredWhen, type RawLeadInput } from './normalise'
export { classifyLead, FREE_RESOURCES_CATEGORY, type ClassifyOptions } from './classify'
export { composePhoneE164, findDialCountry, DIAL_COUNTRIES, type DialCountry } from './dial-codes'
export { londonWallToUtc } from './london-time'
export { scoreLead, type ScoreSignals, type ScoreResult } from './score'
export {
  chooseContactMatch,
  shouldCreateCardOnReenquiry,
  planLeadRouting,
  type ContactCandidate,
  type MatchDecision,
  type LeadRoutingPlan,
} from './match'
