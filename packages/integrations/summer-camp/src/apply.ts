// Apply one Summer Camp booking event to the CRM. CLAUDE.md §2 (idempotent),
// §3 (never auto-merge — adopt only on a single unambiguous match), §5 (audit).
//
// A camp booking enriches the "customer leads CRM": the paying **guardian**
// becomes the primary Contact (kind=parent), the attendee becomes a linked
// student Contact (kind=student), and the booking lands as a `booking`
// Interaction on each timeline. Re-delivery of the same booking updates the
// existing rows rather than duplicating them.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { createCard } from '@studymind/core/board'
import { INVERSE_RELATION } from '@studymind/core/contact'
import type { PrismaClient } from '@studymind/db'

import type { BookingEventEnvelope, BookingResource } from './types'

const ACTOR_ID = 'system:summer-camp'
const REFERRAL_SOURCE = 'Summer Camp'

export interface ApplyResult {
  primaryContactId: string | null
  guardianContactId: string | null
  studentContactId: string | null
  cardId: string | null
  action: 'applied' | 'skipped'
  reason?: string
}

/** Best-effort E.164 normalisation for matching (UK-biased). Returns null when
 *  we cannot make something that looks dialable, so we never store junk. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.replace(/[\s()\-.]/g, '')
  if (!trimmed) return null
  if (trimmed.startsWith('+')) return /^\+\d{6,15}$/.test(trimmed) ? trimmed : null
  if (trimmed.startsWith('00')) {
    const e = `+${trimmed.slice(2)}`
    return /^\+\d{6,15}$/.test(e) ? e : null
  }
  if (trimmed.startsWith('0')) {
    const e = `+44${trimmed.slice(1)}`
    return /^\+\d{6,15}$/.test(e) ? e : null
  }
  return null
}

function cleanEmail(raw: string | null | undefined): string | null {
  const e = raw?.trim().toLowerCase()
  return e && e.includes('@') ? e : null
}

function fullName(person: { name?: string | null; first_name?: string | null; last_name?: string | null } | null | undefined) {
  if (!person) return { firstName: null as string | null, lastName: null as string | null }
  if (person.first_name || person.last_name) {
    return { firstName: person.first_name ?? null, lastName: person.last_name ?? null }
  }
  if (person.name) {
    const parts = person.name.trim().split(/\s+/)
    return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(' ') || null }
  }
  return { firstName: null, lastName: null }
}

/** Pure: pick one contact id from email/phone candidates, or decide to create.
 *  Never merges (§3) — ambiguity (>1) creates a fresh contact instead. */
export function decideMatch(candidateIds: string[]): { use: string } | { create: true } {
  return candidateIds.length === 1 ? { use: candidateIds[0]! } : { create: true }
}

interface UpsertPersonInput {
  kind: 'parent' | 'student'
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  notes: string | null
}

/** Match (email→phone, single unambiguous, never merge) or create a Contact.
 *  On match we only fill blank identity fields — never clobber curated data. */
async function upsertContact(db: PrismaClient, input: UpsertPersonInput): Promise<string> {
  const or: Array<Record<string, string>> = []
  if (input.email) or.push({ email: input.email })
  if (input.phoneE164) or.push({ phoneE164: input.phoneE164 })

  let candidateIds: string[] = []
  if (or.length > 0) {
    const rows = await db.contact.findMany({
      where: { OR: or, kind: input.kind, deletedAt: null },
      select: { id: true },
      take: 5,
    })
    candidateIds = rows.map((r) => r.id)
  }

  const decision = decideMatch(candidateIds)
  if ('use' in decision) {
    const existing = await db.contact.findUnique({
      where: { id: decision.use },
      select: { firstName: true, lastName: true, email: true, phoneE164: true },
    })
    await db.contact.update({
      where: { id: decision.use },
      data: {
        firstName: existing?.firstName ?? input.firstName,
        lastName: existing?.lastName ?? input.lastName,
        email: existing?.email ?? input.email,
        phoneE164: existing?.phoneE164 ?? input.phoneE164,
      },
    })
    return decision.use
  }

  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: input.kind,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phoneE164: input.phoneE164,
      notes: input.notes,
      referralSource: REFERRAL_SOURCE,
    },
  })
  return id
}

async function linkParentStudent(db: PrismaClient, parentId: string, studentId: string): Promise<void> {
  if (parentId === studentId) return
  // Write BOTH directions, like the framework's contact.links.add: the
  // forward `parent_of` (parent → student) and the reciprocal `child_of`
  // (student → parent). `links.list` only reads the forward direction per
  // contact, so without the reciprocal the relationship would show on the
  // parent's page but not the student's. Idempotent via the compound unique key.
  const edges = [
    { from: parentId, to: studentId, relation: 'parent_of' as const },
    { from: studentId, to: parentId, relation: INVERSE_RELATION['parent_of'] },
  ]
  for (const edge of edges) {
    await db.contactLink.upsert({
      where: {
        fromContactId_toContactId_relation: {
          fromContactId: edge.from,
          toContactId: edge.to,
          relation: edge.relation,
        },
      },
      create: {
        id: createId(),
        fromContactId: edge.from,
        toContactId: edge.to,
        relation: edge.relation,
        createdById: ACTOR_ID,
      },
      update: {},
    })
  }
}

/** Resolve where a camp customer lands on the pipeline: the default board's
 *  intake stage ("New leads" if present, else the first stage). Mirrors the
 *  web-lead funnel's destination logic. Returns null if no board exists. */
async function resolveCampDestination(
  db: PrismaClient,
): Promise<{ boardId: string; stageId: string } | null> {
  const board =
    (await db.board.findFirst({
      where: { isDefault: true, archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    })) ??
    (await db.board.findFirst({
      where: { archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    }))
  if (!board) return null

  const stage =
    (await db.pipelineStage.findFirst({
      where: { boardId: board.id, archivedAt: null, name: { equals: 'New leads', mode: 'insensitive' } },
      select: { id: true },
    })) ??
    (await db.pipelineStage.findFirst({
      where: { boardId: board.id, archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    }))
  if (!stage) return null
  return { boardId: board.id, stageId: stage.id }
}

/** Put the camp customer on the sales pipeline so the team works it like any
 *  lead. Deduped: skips when the contact already sits on the board (incl. a
 *  card from the web-lead funnel), so repeat bookings never spam the board. */
async function ensurePipelineCard(
  db: PrismaClient,
  contactId: string,
  envelope: BookingEventEnvelope,
): Promise<string | null> {
  const destination = await resolveCampDestination(db)
  if (!destination) return null

  const existing = await db.card.findFirst({
    where: { contactId, boardId: destination.boardId, archivedAt: null },
    select: { id: true },
  })
  if (existing) return existing.id

  const card = await createCard(
    db,
    { boardId: destination.boardId, stageId: destination.stageId, contact: { contactId } },
    { actorId: ACTOR_ID, requestId: `summer-camp:${envelope.booking.id}` },
  )
  return card.id
}

function buildSummary(b: BookingResource): string {
  const parts = [
    b.camp_name ?? 'Summer camp',
    b.subject ? `· ${b.subject}` : null,
    b.week_label ?? (b.week_number ? `Week ${b.week_number}` : null),
    b.status ? `(${b.status})` : null,
  ].filter(Boolean)
  return parts.join(' ').slice(0, 280)
}

function occurredAt(b: BookingResource): Date {
  const candidate = b.start_date ?? b.created_at
  if (candidate) {
    const d = new Date(candidate)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

async function writeBookingInteraction(
  db: PrismaClient,
  contactId: string,
  envelope: BookingEventEnvelope,
): Promise<void> {
  const b = envelope.booking
  const summary = buildSummary(b)
  const payload = {
    kind: 'summer_camp.booking',
    externalBookingId: b.id,
    lastEvent: envelope.type,
    status: b.status,
    bookingType: b.booking_type,
    campId: b.camp_id,
    campName: b.camp_name,
    subject: b.subject,
    weekNumber: b.week_number ?? null,
    weekLabel: b.week_label,
    startDate: b.start_date,
    endDate: b.end_date,
    withAccommodation: b.with_accommodation ?? false,
    withTransfer: b.with_transfer ?? false,
    totalMinor: b.payment?.total_minor ?? null,
    paidMinor: b.payment?.paid_minor ?? null,
    studentName: [b.student?.first_name, b.student?.last_name].filter(Boolean).join(' ') || null,
  }

  const existing = await db.interaction.findFirst({
    where: { contactId, type: 'booking', payload: { path: ['externalBookingId'], equals: b.id } },
    select: { id: true },
  })
  if (existing) {
    await db.interaction.update({
      where: { id: existing.id },
      data: { summary, occurredAt: occurredAt(b), payload },
    })
    return
  }
  await db.interaction.create({
    data: { id: createId(), type: 'booking', contactId, occurredAt: occurredAt(b), summary, payload },
  })
}

/**
 * Apply one booking event. Idempotent: contacts match-or-create, the booking
 * interaction upserts on `payload.externalBookingId`, and the audit row dedupes
 * on `requestId = envelope.id`, so an Inngest retry never double-writes.
 */
export async function applyBookingEvent(
  db: PrismaClient,
  envelope: BookingEventEnvelope,
): Promise<ApplyResult> {
  const b = envelope.booking

  const guardianEmail = cleanEmail(b.guardian?.email)
  const guardianPhone = normalisePhone(b.guardian?.mobile)
  const guardian = fullName(b.guardian)
  const hasGuardian = Boolean(guardianEmail || guardianPhone || guardian.firstName)

  const studentEmail = cleanEmail(b.student?.email)
  const studentPhone = normalisePhone(b.student?.mobile)
  const student = fullName(b.student)
  const hasStudent = Boolean(student.firstName || student.lastName || studentEmail || studentPhone)

  if (!hasGuardian && !hasStudent) {
    return { primaryContactId: null, guardianContactId: null, studentContactId: null, cardId: null, action: 'skipped', reason: 'no_identifiable_person' }
  }

  const campNote = b.camp_name ? `Summer camp booking: ${b.camp_name}` : 'Summer camp booking'

  let guardianContactId: string | null = null
  if (hasGuardian) {
    guardianContactId = await upsertContact(db, {
      kind: 'parent',
      firstName: guardian.firstName,
      lastName: guardian.lastName,
      email: guardianEmail,
      phoneE164: guardianPhone,
      notes: campNote,
    })
  }

  let studentContactId: string | null = null
  if (hasStudent) {
    studentContactId = await upsertContact(db, {
      kind: 'student',
      firstName: student.firstName,
      lastName: student.lastName,
      email: studentEmail,
      phoneE164: studentPhone,
      notes: campNote,
    })
  }

  if (guardianContactId && studentContactId) {
    await linkParentStudent(db, guardianContactId, studentContactId)
  }

  const primaryContactId = guardianContactId ?? studentContactId
  // The booking lands on the timeline of both the customer (parent) and the
  // attendee (student) so each contact's history is complete.
  const targets = [guardianContactId, studentContactId].filter((id): id is string => Boolean(id))
  for (const contactId of targets) {
    await writeBookingInteraction(db, contactId, envelope)
  }

  // Surface the customer on the sales pipeline (like a lead) — but never for a
  // cancellation, and deduped so it's at most one card per contact per board.
  let cardId: string | null = null
  if (primaryContactId && envelope.type !== 'summer_camp.booking.cancelled') {
    cardId = await ensurePipelineCard(db, primaryContactId, envelope)
  }

  if (primaryContactId) {
    await writeAuditLogEntry(db, {
      actorId: ACTOR_ID,
      action: envelope.type,
      target: { type: 'contact', id: primaryContactId },
      requestId: envelope.id,
      after: { externalBookingId: b.id, status: b.status, campName: b.camp_name, cardId },
    })
  }

  return { primaryContactId, guardianContactId, studentContactId, cardId, action: 'applied' }
}
