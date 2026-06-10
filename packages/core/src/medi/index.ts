// Medi Platform (Medic Mind UCAT portal) account-sync domain (ADR 0037).
// Pure normalisation + match decision; the Contact resolver lives in
// ../contact/from-medi.ts (db + audit) and the orchestration in
// @studymind/jobs/medi/process-account.

export {
  mediAccountPayloadSchema,
  normaliseMediAccount,
  type MediAccountPayload,
  type NormalisedMediAccount,
  type NormalisedMediParty,
  type NormalisedMediRelatedParty,
} from './types'

export {
  decideMediMatch,
  type MediContactCandidate,
  type MediMatchDecision,
  type MediMatchInput,
} from './match'
