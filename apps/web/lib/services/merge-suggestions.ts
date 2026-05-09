// Contact merge suggestion service. CLAUDE.md §3, §18, §35.
//
// Heuristic candidate selection (shared phone or email, or fuzzy first
// name + same family postcode area), then runs the merge-candidates
// prompt for each pair. Returns top suggestions ordered by confidence.
// Never writes — suggestions are presented for human confirmation only.

import {
  buildMergeCandidatesPrompt,
  MERGE_CANDIDATES_PROMPT_VERSION,
  MERGE_SUGGESTION_THRESHOLD,
  mergeCandidateSchema,
  runStructured,
  type ContactSummaryForMerge,
} from '@studymind/ai'
import type { PrismaClient } from '@prisma/client'

const MAX_CANDIDATES = 10
const MAX_SUGGESTIONS = 5

export interface MergeSuggestion {
  candidateContactId: string
  confidence: number
  signals: string[]
  promptVersion: string
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return null
  return `•••• ••${digits.slice(-2)}`
}

function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at <= 0) return null
  const local = email.slice(0, at)
  const visible = local.slice(0, Math.min(4, local.length))
  return `${visible}••@`
}

function toSummary(row: {
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  kind: string
}): ContactSummaryForMerge {
  return {
    firstName: row.firstName,
    lastInitial: row.lastName ? row.lastName.charAt(0).toUpperCase() : null,
    phoneMasked: maskPhone(row.phoneE164),
    emailMasked: maskEmail(row.email),
    kind: row.kind,
    postcodeArea: null,
  }
}

export async function findMergeCandidates(
  db: PrismaClient,
  seedContactId: string,
): Promise<MergeSuggestion[]> {
  const seed = await db.contact.findUnique({
    where: { id: seedContactId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneE164: true,
      kind: true,
    },
  })
  if (!seed) return []

  // Heuristic shortlist: shared phone OR email OR (same first name).
  const orFilters: Array<Record<string, unknown>> = []
  if (seed.phoneE164) orFilters.push({ phoneE164: seed.phoneE164 })
  if (seed.email) orFilters.push({ email: seed.email })
  if (seed.firstName) orFilters.push({ firstName: seed.firstName })
  if (orFilters.length === 0) return []

  const candidates = await db.contact.findMany({
    where: {
      deletedAt: null,
      id: { not: seed.id },
      OR: orFilters,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneE164: true,
      kind: true,
    },
    take: MAX_CANDIDATES,
  })

  if (candidates.length === 0) return []

  const seedSummary = toSummary(seed)
  const suggestions: MergeSuggestion[] = []

  for (const candidate of candidates) {
    const candidateSummary = toSummary(candidate)
    const prompt = buildMergeCandidatesPrompt({ a: seedSummary, b: candidateSummary })
    const out = await runStructured({
      task: 'merge_suggestion',
      promptVersion: prompt.promptVersion,
      schema: mergeCandidateSchema,
      schemaName: 'MergeCandidate',
      system: prompt.system,
      user: prompt.user,
      model: 'gpt-4o-mini',
      contactId: seed.id,
      ctx: { seedContactId: seed.id, candidateContactId: candidate.id },
    })
    if (out.confidence < MERGE_SUGGESTION_THRESHOLD) continue
    suggestions.push({
      candidateContactId: candidate.id,
      confidence: out.confidence,
      signals: out.signals,
      promptVersion: MERGE_CANDIDATES_PROMPT_VERSION,
    })
  }

  suggestions.sort((a, b) => b.confidence - a.confidence)
  return suggestions.slice(0, MAX_SUGGESTIONS)
}
