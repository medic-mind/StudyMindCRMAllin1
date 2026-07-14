// CRM → camp write-back (two-way sync). Pushes CRM-side edits + notes back to
// the matching camp booking. The camp stays the store of paid bookings — we
// only ever UPDATE an existing booking, never create one. All functions are
// best-effort and never throw: a sync failure must not fail the CRM mutation
// that triggered it. Loop-prevention: the camp tags our writes `system:crm`
// and does not echo them back; the booking feed marks them `source:'crm'` so
// the CRM skips re-importing its own note.

import type { PrismaClient } from '@studymind/db'

import { createClientFromConfig } from './client'

export interface PushResult {
  ok: boolean
  skipped?: boolean
  reason?: string
}

/**
 * The camp booking id this contact is linked to, from its most recent Summer
 * Camp `booking` Interaction. Returns null when the contact has no camp booking
 * (so write-back is a no-op for non-camp contacts).
 */
export async function findCampBookingId(db: PrismaClient, contactId: string): Promise<string | null> {
  const row = await db.interaction.findFirst({
    where: { contactId, type: 'booking', payload: { path: ['kind'], equals: 'summer_camp.booking' } },
    orderBy: { occurredAt: 'desc' },
    select: { payload: true },
  })
  if (!row) return null
  const payload = row.payload as { externalBookingId?: unknown } | null
  const id = payload?.externalBookingId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Push a CRM-authored note onto the contact's linked camp booking. */
export async function pushNoteForContact(
  db: PrismaClient,
  contactId: string,
  body: string,
  author?: string | null,
): Promise<PushResult> {
  const client = createClientFromConfig()
  if (!client) return { ok: false, skipped: true, reason: 'not_configured' }
  try {
    const bookingId = await findCampBookingId(db, contactId)
    if (!bookingId) return { ok: false, skipped: true, reason: 'not_camp_linked' }
    await client.postNote(bookingId, body, author)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'push failed' }
  }
}

/** Map the CRM contact's editable identity fields onto the camp booking shape.
 *  `kind` selects whether the contact is the attendee (student_*) or the
 *  guardian. Only non-empty fields are sent. */
export interface ContactDetailForPush {
  kind: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
}

export function mapContactToBookingFields(c: ContactDetailForPush): Record<string, string> {
  const fields: Record<string, string> = {}
  const isStudent = c.kind === 'student'
  if (isStudent) {
    if (c.firstName) fields['student_first_name'] = c.firstName
    if (c.lastName) fields['student_last_name'] = c.lastName
    if (c.email) fields['student_email'] = c.email
    if (c.phoneE164) fields['student_mobile'] = c.phoneE164
  } else {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ')
    if (name) fields['guardian_name'] = name
    if (c.email) fields['guardian_email'] = c.email
    if (c.phoneE164) fields['guardian_mobile'] = c.phoneE164
  }
  return fields
}

/** Booking fields the camp accepts on PATCH (its write-back whitelist). */
export interface BookingFieldsForPush {
  status?: string
  subject?: string
  notes?: string
}

/** Push booking-level edits (status / subject / camp notes) onto a specific
 *  camp booking. Used by the bookings workspace, where the exact booking id is
 *  known (a contact can hold several bookings). */
export async function pushBookingFields(
  bookingId: string,
  fields: BookingFieldsForPush,
): Promise<PushResult> {
  const client = createClientFromConfig()
  if (!client) return { ok: false, skipped: true, reason: 'not_configured' }
  const payload = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as Record<string, string>
  if (Object.keys(payload).length === 0) return { ok: false, skipped: true, reason: 'nothing_to_push' }
  try {
    await client.patchBooking(bookingId, payload)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'push failed' }
  }
}

/** Assign the booking's student to camps on the camp app (first id = primary).
 *  The camp owns assignment, so this is the authoritative write; the CRM
 *  mirror converges via the webhook/reconcile pull. */
export async function pushCampAssignment(bookingId: string, campIds: string[]): Promise<PushResult> {
  const client = createClientFromConfig()
  if (!client) return { ok: false, skipped: true, reason: 'not_configured' }
  try {
    await client.putCampAssignment(bookingId, campIds)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'push failed' }
  }
}

export interface NotePushResult extends PushResult {
  /** The camp's note id (the CRM stores it as the feed-dedupe key). */
  campNoteId?: string | null
}

/** Push a note onto a SPECIFIC camp booking (the bookings-workspace path —
 *  unlike pushNoteForContact, which targets the contact's latest booking). */
export async function pushNoteForBooking(
  bookingId: string,
  body: string,
  author?: string | null,
): Promise<NotePushResult> {
  const client = createClientFromConfig()
  if (!client) return { ok: false, skipped: true, reason: 'not_configured' }
  try {
    const campNoteId = await client.postNote(bookingId, body, author)
    return { ok: true, campNoteId }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'push failed' }
  }
}

/** Push the contact's current identity fields onto its linked camp booking. */
export async function pushContactDetailsForContact(db: PrismaClient, contactId: string): Promise<PushResult> {
  const client = createClientFromConfig()
  if (!client) return { ok: false, skipped: true, reason: 'not_configured' }
  try {
    const [bookingId, contact] = await Promise.all([
      findCampBookingId(db, contactId),
      db.contact.findUnique({
        where: { id: contactId },
        select: { kind: true, firstName: true, lastName: true, email: true, phoneE164: true },
      }),
    ])
    if (!bookingId) return { ok: false, skipped: true, reason: 'not_camp_linked' }
    if (!contact) return { ok: false, skipped: true, reason: 'contact_not_found' }
    const fields = mapContactToBookingFields(contact)
    if (Object.keys(fields).length === 0) return { ok: false, skipped: true, reason: 'nothing_to_push' }
    await client.patchBooking(bookingId, fields)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'push failed' }
  }
}
