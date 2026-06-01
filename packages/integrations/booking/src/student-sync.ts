// Booking → CRM mapping + upserts (student-centric, ADR 0029).
//
// A booking "student" maps to a Contact (kind = student) keyed on
// `Contact.bookingContactId = uuid`; lessons / hours / credits hang off that
// Contact. We never auto-MERGE two CRM contacts (CLAUDE.md §3): we adopt an
// existing contact only on a single unambiguous email/phone match, otherwise we
// create. Identity fields on an existing contact are only filled when empty —
// the booking site is the source of truth for hours, not for hand-curated CRM
// fields.
//
// The pure pieces (`drainIncremental`, `decideContactMatch`,
// `deriveBookingStatus`) are unit-tested; the db upserts are exercised against
// real Postgres in integration tests only (CLAUDE.md §23.2 — we don't unit-test
// that Postgres works).

import { createId } from '@paralleldrive/cuid2'

import type { PrismaClient } from '@studymind/db'

import type {
  BookingCreditTxnResource,
  BookingHoursTxnResource,
  BookingLessonResource,
  BookingStudent,
  Page,
} from './types'

export type BookingStatus = 'lead' | 'registered_no_hours' | 'registered_with_hours'

// -----------------------------------------------------------------------------
// Incremental walk (pure). Drives the cursor across runs: while walking a page
// set we keep the same `updatedSince` and advance `cursor`; once drained we
// advance `updatedSince` to the high-water mark and clear the cursor. Bounded by
// `maxPages` per invocation so one cron tick cannot run unbounded on the first
// (full backfill) pass — the next tick resumes from the persisted cursor.
// -----------------------------------------------------------------------------

export interface SyncState {
  updatedSince: Date | null
  cursor: string | null
}

export interface DrainResult {
  processed: number
  pages: number
  newState: SyncState
  drained: boolean
}

export async function drainIncremental<T extends { updatedAt: Date }>(opts: {
  state: SyncState
  maxPages: number
  fetchPage: (q: { updatedSince: Date | null; cursor: string | null }) => Promise<Page<T>>
  processItem: (item: T) => Promise<void>
}): Promise<DrainResult> {
  const { updatedSince } = opts.state
  let cursor = opts.state.cursor
  let maxSeen: Date | null = updatedSince
  let processed = 0
  let pages = 0
  let drained = false

  while (pages < opts.maxPages) {
    const page = await opts.fetchPage({ updatedSince, cursor })
    pages += 1
    for (const item of page.data) {
      await opts.processItem(item)
      processed += 1
      if (!maxSeen || item.updatedAt > maxSeen) maxSeen = item.updatedAt
    }
    if (page.hasMore && page.nextCursor) {
      cursor = page.nextCursor
    } else {
      drained = true
      break
    }
  }

  const newState: SyncState = drained
    ? { updatedSince: maxSeen, cursor: null }
    : { updatedSince, cursor }
  return { processed, pages, newState, drained }
}

// -----------------------------------------------------------------------------
// Contact matching (pure). See CLAUDE.md §3 — adopt only on a single
// unambiguous match; never merge.
// -----------------------------------------------------------------------------

export type ContactMatchAction =
  | { kind: 'use'; contactId: string }
  | { kind: 'link'; contactId: string }
  | { kind: 'create' }

export interface MatchCandidates {
  /** Contact already linked to this booking uuid, if any. */
  byBookingId: string | null
  /** Contacts matching by email/phone that are not yet linked to any booking id. */
  byEmailOrPhone: string[]
}

export function decideContactMatch(c: MatchCandidates): ContactMatchAction {
  if (c.byBookingId) return { kind: 'use', contactId: c.byBookingId }
  if (c.byEmailOrPhone.length === 1) return { kind: 'link', contactId: c.byEmailOrPhone[0]! }
  return { kind: 'create' }
}

export function deriveBookingStatus(student: BookingStudent): BookingStatus {
  const b = student.balance
  const c = student.credits
  const hasHours = b.hoursAdded > 0 || b.hoursRemaining > 0 || b.premiumHoursAdded > 0
  const hasCredits = c.onlineMmi > 0 || c.inPersonMmi > 0 || c.liveDay > 0 || c.inPersonLiveDay > 0
  return hasHours || hasCredits ? 'registered_with_hours' : 'registered_no_hours'
}

function isMinor(dob: Date | null, now: Date): boolean {
  if (!dob) return false
  const eighteenAgo = new Date(now)
  eighteenAgo.setFullYear(now.getFullYear() - 18)
  return dob > eighteenAgo
}

// -----------------------------------------------------------------------------
// DB upserts. Idempotent on the booking site's native ids.
// -----------------------------------------------------------------------------

export interface UpsertStudentResult {
  contactId: string | null
  action: ContactMatchAction['kind'] | 'skipped'
}

export async function upsertStudent(
  db: PrismaClient,
  student: BookingStudent,
  now: Date = new Date(),
): Promise<UpsertStudentResult> {
  const linked = await db.contact.findFirst({
    where: { bookingContactId: student.uuid },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneE164: true,
      dateOfBirth: true,
      country: true,
    },
  })

  let candidates: string[] = []
  if (!linked && (student.email || student.phoneE164)) {
    const or: Array<Record<string, string>> = []
    if (student.email) or.push({ email: student.email })
    if (student.phoneE164) or.push({ phoneE164: student.phoneE164 })
    const rows = await db.contact.findMany({
      where: { OR: or, bookingContactId: null, deletedAt: null },
      select: { id: true },
      take: 5,
    })
    candidates = rows.map((r) => r.id)
  }

  const action = decideContactMatch({
    byBookingId: linked?.id ?? null,
    byEmailOrPhone: candidates,
  })

  // Don't create a contact for a student already deleted on the booking site
  // with no CRM footprint — there is nothing to mirror.
  if (action.kind === 'create' && student.deletedAt) {
    return { contactId: null, action: 'skipped' }
  }

  const status = deriveBookingStatus(student)
  const summary = {
    bookingStatus: status,
    bookingContactId: student.uuid,
    bookingLastSyncAt: now,
    hoursBooked: Math.round(student.balance.hoursAdded),
    hoursDelivered: Math.round(student.balance.hoursUsed),
  }

  let contactId: string
  if (action.kind === 'create') {
    contactId = createId()
    await db.contact.create({
      data: {
        id: contactId,
        kind: 'student',
        firstName: student.firstName,
        lastName: student.lastName,
        email: student.email,
        phoneE164: student.phoneE164,
        dateOfBirth: student.dateOfBirth,
        isMinor: isMinor(student.dateOfBirth, now),
        country: student.country,
        ...summary,
      },
    })
  } else {
    contactId = action.contactId
    // Fill identity fields only when empty — never clobber hand-curated CRM
    // data (CLAUDE.md §3). Always refresh booking-derived metrics + the link.
    await db.contact.update({
      where: { id: contactId },
      data: {
        firstName: linked?.firstName ?? student.firstName,
        lastName: linked?.lastName ?? student.lastName,
        email: linked?.email ?? student.email,
        phoneE164: linked?.phoneE164 ?? student.phoneE164,
        dateOfBirth: linked?.dateOfBirth ?? student.dateOfBirth,
        country: linked?.country ?? student.country,
        ...summary,
      },
    })
  }

  await upsertBookingProfile(db, contactId, student, now)
  return { contactId, action: action.kind }
}

async function upsertBookingProfile(
  db: PrismaClient,
  contactId: string,
  student: BookingStudent,
  now: Date,
): Promise<void> {
  const data = {
    legacyStudentId: student.legacyId,
    hasGuardian: student.hasGuardian,
    guardianName: student.guardianName,
    guardianPhoneE164: student.guardianPhoneE164,
    guardianEmail: student.guardianEmail,
    receiveMarketingEmails: student.receiveMarketingEmails,
    addedByAgent: student.addedByAgent,
    registeredAt: student.registeredAt,
    hoursAdded: student.balance.hoursAdded,
    hoursUsed: student.balance.hoursUsed,
    hoursDeducted: student.balance.hoursDeducted,
    hoursRemaining: student.balance.hoursRemaining,
    premiumHoursAdded: student.balance.premiumHoursAdded,
    premiumHoursUsed: student.balance.premiumHoursUsed,
    premiumHoursDeducted: student.balance.premiumHoursDeducted,
    premiumHoursRemaining: student.balance.premiumHoursRemaining,
    nextHoursExpiryAt: student.balance.nextExpiryAt,
    creditsOnlineMmi: student.credits.onlineMmi,
    creditsInPersonMmi: student.credits.inPersonMmi,
    creditsLiveDay: student.credits.liveDay,
    creditsInPersonLiveDay: student.credits.inPersonLiveDay,
    lastSyncedAt: now,
  }
  await db.contactBookingProfile.upsert({
    where: { contactId },
    create: { contactId, ...data },
    update: data,
  })
}

/** A lesson counts toward "last lesson" once it is in the past and not
 *  cancelled. Precise per-lesson delivered-hours recompute is a follow-up. */
function countsAsDelivered(lesson: BookingLessonResource, now: Date): boolean {
  return lesson.status !== 'cancelled' && lesson.startsAt <= now
}

export async function upsertLesson(
  db: PrismaClient,
  lesson: BookingLessonResource,
  now: Date = new Date(),
): Promise<{ contactId: string | null }> {
  const contact = await db.contact.findFirst({
    where: { bookingContactId: lesson.studentUuid },
    select: { id: true, lastLessonAt: true },
  })
  // The student sync owns contact creation; a lesson seen before its student is
  // rare and resolves on the next students tick (idempotent re-pull).
  if (!contact) return { contactId: null }

  const data = {
    contactId: contact.id,
    tutorExternalId: lesson.tutorExternalId,
    tutorName: lesson.tutorName,
    subject: lesson.subject,
    startsAt: lesson.startsAt,
    endsAt: lesson.endsAt,
    durationMinutes: lesson.durationMinutes,
    status: lesson.status,
    payment: lesson.payment,
    isTrial: lesson.isTrial,
    trialFeedback: lesson.trialFeedback,
    trialFeedbackStatus: lesson.trialFeedbackStatus,
    deletedAt: lesson.deletedAt,
  }
  await db.bookingLesson.upsert({
    where: { externalId: lesson.externalId },
    create: { id: createId(), externalId: lesson.externalId, ...data },
    update: data,
  })

  await writeLessonInteraction(db, contact.id, lesson)

  if (
    countsAsDelivered(lesson, now) &&
    (!contact.lastLessonAt || lesson.startsAt > contact.lastLessonAt)
  ) {
    await db.contact.update({
      where: { id: contact.id },
      data: { lastLessonAt: lesson.startsAt },
    })
  }
  return { contactId: contact.id }
}

async function writeLessonInteraction(
  db: PrismaClient,
  contactId: string,
  lesson: BookingLessonResource,
): Promise<void> {
  // Idempotent on (contactId, type=booking, payload.externalLessonId).
  const existing = await db.interaction.findFirst({
    where: {
      contactId,
      type: 'booking',
      payload: { path: ['externalLessonId'], equals: lesson.externalId },
    },
    select: { id: true },
  })
  const summary = [
    lesson.subject ? lesson.subject.toUpperCase() : 'Lesson',
    lesson.tutorName ? `with ${lesson.tutorName}` : null,
    `(${lesson.status})`,
  ]
    .filter(Boolean)
    .join(' ')
  const payload = {
    kind: 'booking.lesson',
    externalLessonId: lesson.externalId,
    status: lesson.status,
    payment: lesson.payment,
    subject: lesson.subject,
    tutorName: lesson.tutorName,
    startsAt: lesson.startsAt.toISOString(),
  }
  if (existing) {
    await db.interaction.update({
      where: { id: existing.id },
      data: { summary, occurredAt: lesson.startsAt, payload },
    })
    return
  }
  await db.interaction.create({
    data: {
      id: createId(),
      type: 'booking',
      contactId,
      occurredAt: lesson.startsAt,
      summary,
      payload,
    },
  })
}

export async function upsertHoursTransaction(
  db: PrismaClient,
  txn: BookingHoursTxnResource,
): Promise<{ contactId: string | null }> {
  const contact = await db.contact.findFirst({
    where: { bookingContactId: txn.studentUuid },
    select: { id: true },
  })
  if (!contact) return { contactId: null }
  const data = {
    contactId: contact.id,
    hours: txn.hours,
    isPremium: txn.isPremium,
    amountMinor: txn.amountMinor,
    stripeReference: txn.stripeReference,
    message: txn.message,
    type: txn.type,
    adminExternalId: txn.adminExternalId,
    adminName: txn.adminName,
    occurredAt: txn.occurredAt,
    expiresAt: txn.expiresAt,
    deletedAt: txn.deletedAt,
  }
  await db.bookingHoursTransaction.upsert({
    where: { externalId: txn.externalId },
    create: { id: createId(), externalId: txn.externalId, ...data },
    update: data,
  })
  return { contactId: contact.id }
}

export async function upsertCreditTransaction(
  db: PrismaClient,
  txn: BookingCreditTxnResource,
): Promise<{ contactId: string | null }> {
  const contact = await db.contact.findFirst({
    where: { bookingContactId: txn.studentUuid },
    select: { id: true },
  })
  if (!contact) return { contactId: null }
  const data = {
    contactId: contact.id,
    creditKind: txn.creditKind,
    credits: txn.credits,
    amountMinor: txn.amountMinor,
    stripeReference: txn.stripeReference,
    message: txn.message,
    type: txn.type,
    adminExternalId: txn.adminExternalId,
    adminName: txn.adminName,
    occurredAt: txn.occurredAt,
    deletedAt: txn.deletedAt,
  }
  await db.bookingCreditTransaction.upsert({
    where: { externalId: txn.externalId },
    create: { id: createId(), externalId: txn.externalId, ...data },
    update: data,
  })
  return { contactId: contact.id }
}
