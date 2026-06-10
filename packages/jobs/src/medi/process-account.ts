// Worker for the Medi Platform (Medic Mind UCAT portal) account sync (ADR 0037).
//
// The POST /api/contacts receiver persists each `user.registered` event to
// ProviderEvent (idempotent on the Medi user id) and enqueues
// `medi/account.received`. This job does the real work, idempotently:
//   1. resolve/create the account-holder Contact (email→phone match, §3/§41.1)
//   2. record a `note` Interaction: imported from the Medi Platform
//   3. if a related parent/student was named, resolve/create + link them
//   4. mark the ProviderEvent processed + write a summary audit row
//
// It deliberately does NOT create a board card / pipeline entry — a Medi signup
// is a record, not a sales lead. It is pure db + audit + core (no AI /
// integration clients), so it is a cross-cutting function with no boundary glue.

import { createHash } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { resolveOrCreateContactForMediAccount } from '@studymind/core/contact/from-medi'
import { normaliseMediAccount, type NormalisedMediAccount } from '@studymind/core/medi'
import { db } from '@studymind/db'

import { inngest } from '../client'

type Db = typeof db

/** Stamped onto every Contact this job creates, and the filter the team uses. */
export const MEDI_REFERRAL_SOURCE = 'Medi Platform (UCAT portal)'
const ACTOR = 'system:medi-account-sync'

// Contacts created here carry the self-declared role from the portal — real
// data the person gave us, not a guess, so we classify accurately rather than
// defaulting everyone to one kind. A school teacher on the portal is `other`
// (they are not a StudyMind tutor). Existing contacts keep their own kind.
type SyncContactKind = 'student' | 'parent' | 'other' | 'unclassified'

function kindForRole(role: string | null): SyncContactKind {
  switch ((role ?? '').toLowerCase()) {
    case 'student':
      return 'student'
    case 'parent':
      return 'parent'
    case 'teacher':
      return 'other'
    default:
      return 'unclassified'
  }
}

function kindForRelation(relation: string | null): SyncContactKind {
  // The related party is the COUNTERPART named on the signup.
  switch ((relation ?? '').toLowerCase()) {
    case 'parent_of_student':
      return 'parent'
    case 'student_of_parent':
      return 'student'
    default:
      return 'unclassified'
  }
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002',
  )
}

/** Deterministic, idempotent "imported from Medi" note so retries never dupe. */
async function ensureImportNote(
  database: Db,
  args: { eventId: string; contactId: string; summary: string; payload: object },
): Promise<void> {
  const hash = createHash('sha256')
    .update(`medi-note:${args.eventId}:${args.contactId}`)
    .digest('hex')
    .slice(0, 24)
  const id = `medi-note-${hash}`
  const existing = await database.interaction.findUnique({ where: { id }, select: { id: true } })
  if (existing) return
  await database.interaction.create({
    data: {
      id,
      type: 'note',
      contactId: args.contactId,
      occurredAt: new Date(),
      summary: args.summary,
      payload: args.payload,
      createdById: ACTOR,
      updatedById: ACTOR,
    },
  })
}

async function ensureLink(
  database: Db,
  fromContactId: string,
  toContactId: string,
  relation: 'parent_of' | 'child_of',
): Promise<void> {
  const existing = await database.contactLink.findUnique({
    where: { fromContactId_toContactId_relation: { fromContactId, toContactId, relation } },
    select: { id: true },
  })
  if (existing) return
  try {
    await database.contactLink.create({
      data: { id: createId(), fromContactId, toContactId, relation, createdById: ACTOR },
    })
    await writeAuditLogEntry(database, {
      actorId: ACTOR,
      requestId: `medi-link:${fromContactId}:${toContactId}:${relation}`,
      action: 'contact.link_added',
      target: { type: 'Contact', id: fromContactId },
      after: { toContactId, relation, source: 'medi' },
    })
  } catch (err) {
    if (isUniqueViolation(err)) return
    throw err
  }
}

/** Reciprocally link the account holder and their named parent/student. */
async function linkParentStudent(
  database: Db,
  normalised: NormalisedMediAccount,
  accountContactId: string,
  relatedContactId: string,
): Promise<void> {
  const relation = (normalised.related?.relation ?? '').toLowerCase()
  let parentId: string | null = null
  let studentId: string | null = null
  if (relation === 'parent_of_student') {
    parentId = relatedContactId
    studentId = accountContactId
  } else if (relation === 'student_of_parent') {
    parentId = accountContactId
    studentId = relatedContactId
  } else {
    return
  }
  if (!parentId || !studentId || parentId === studentId) return
  await ensureLink(database, parentId, studentId, 'parent_of')
  await ensureLink(database, studentId, parentId, 'child_of')
}

export interface ProcessMediAccountResult {
  status: 'processed' | 'already_processed' | 'missing' | 'invalid'
  contactId?: string
  relatedContactId?: string
  created?: boolean
  triageRequired?: boolean
}

/**
 * Idempotently turn a stored `medi` ProviderEvent into a Contact (+ note, +
 * optional related-contact link). Safe to replay — every step matches or
 * upserts, and a processed event short-circuits.
 */
export async function processMediAccount(
  database: Db,
  eventId: string,
): Promise<ProcessMediAccountResult> {
  const event = await database.providerEvent.findUnique({
    where: { provider_eventId: { provider: 'medi', eventId } },
    select: { id: true, raw: true, processedAt: true },
  })
  if (!event) return { status: 'missing' }
  if (event.processedAt) return { status: 'already_processed' }

  const normalised = normaliseMediAccount(event.raw)
  if (!normalised) {
    await database.providerEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    })
    return { status: 'invalid' }
  }

  // 1. The account holder.
  const account = await resolveOrCreateContactForMediAccount(database, normalised.account, {
    referralSource: MEDI_REFERRAL_SOURCE,
    kind: kindForRole(normalised.role),
    actorId: ACTOR,
    requestId: eventId,
  })
  if (!account) {
    await database.providerEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    })
    return { status: 'invalid' }
  }

  // 2. The "imported from Medi Platform" note.
  await ensureImportNote(database, {
    eventId,
    contactId: account.contactId,
    summary: 'Imported from the Medi Platform — the Medic Mind UCAT portal.',
    payload: {
      source: 'medi',
      event: normalised.event,
      mediUserId: normalised.mediUserId,
      role: normalised.role,
      country: normalised.country,
      triageRequired: account.triageRequired,
    },
  })

  // 3. The named parent/student counterpart, if any.
  let relatedContactId: string | undefined
  if (normalised.related && (normalised.related.email || normalised.related.phoneE164)) {
    const related = await resolveOrCreateContactForMediAccount(database, normalised.related, {
      referralSource: MEDI_REFERRAL_SOURCE,
      kind: kindForRelation(normalised.related.relation),
      actorId: ACTOR,
      requestId: eventId,
    })
    if (related) {
      relatedContactId = related.contactId
      await ensureImportNote(database, {
        eventId,
        contactId: related.contactId,
        summary: 'Added from the Medi Platform — named as a related contact on a UCAT portal signup.',
        payload: {
          source: 'medi',
          event: normalised.event,
          mediUserId: normalised.mediUserId,
          relation: normalised.related.relation,
          relatedTo: account.contactId,
        },
      })
      await linkParentStudent(database, normalised, account.contactId, related.contactId)
    }
  }

  // 4. Mark processed + write the summary audit row.
  await database.providerEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date() },
  })
  await writeAuditLogEntry(database, {
    actorId: ACTOR,
    requestId: eventId,
    action: 'medi.account_synced',
    target: { type: 'Contact', id: account.contactId },
    after: {
      mediUserId: normalised.mediUserId,
      event: normalised.event,
      role: normalised.role,
      created: account.created,
      matchedBy: account.matchedBy,
      triageRequired: account.triageRequired,
      relatedContactId: relatedContactId ?? null,
    },
  })

  return {
    status: 'processed',
    contactId: account.contactId,
    relatedContactId,
    created: account.created,
    triageRequired: account.triageRequired,
  }
}

export const mediAccountReceived = inngest.createFunction(
  {
    id: 'medi/process-account',
    name: 'Medi Platform: sync a UCAT portal account into a Contact',
    concurrency: { limit: 5 },
    retries: 6,
  },
  { event: 'medi/account.received' },
  async ({ event, step, logger }) => {
    const { eventId } = event.data as { eventId: string }
    const result = await step.run('process', () => processMediAccount(db, eventId))
    logger.info(
      { eventId, status: result.status, contactId: result.contactId, created: result.created },
      'medi.account.processed',
    )
    return result
  },
)

export const MEDI_FUNCTIONS = [mediAccountReceived]
