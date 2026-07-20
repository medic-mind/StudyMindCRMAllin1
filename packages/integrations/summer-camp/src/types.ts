// Domain-mapped types for the Summer Camp integration (camp.studymind.co.uk).
// We never let raw camp-app shapes leak past this file — the rest of the CRM
// consumes the Zod-parsed `BookingEventEnvelope`. Money arrives as integer
// minor units (pence) per the cross-app contract (camp `CRM_INTEGRATION.md`).

import { z } from 'zod'

export const SUMMER_CAMP_PROVIDER = 'summer-camp' as const

/** The three booking lifecycle events the camp app pushes. */
export const BookingEventType = z.enum([
  'summer_camp.booking.created',
  'summer_camp.booking.updated',
  'summer_camp.booking.cancelled',
])
export type BookingEventType = z.infer<typeof BookingEventType>

const nullableString = z.string().nullable().optional()

export const BookingPerson = z.object({
  first_name: nullableString,
  last_name: nullableString,
  name: nullableString,
  email: nullableString,
  mobile: nullableString,
})

/** The attendee carries richer per-student detail than a guardian. Sensitive
 *  fields (medical, emergency) are flagged for careful handling (CLAUDE.md §21). */
export const BookingStudent = BookingPerson.extend({
  dietary_requirements: nullableString,
  medical_notes: nullableString,
  emergency_contact_name: nullableString,
  emergency_contact_phone: nullableString,
})

export const BookingPayment = z.object({
  total_minor: z.number().int().nullable().optional(),
  paid_minor: z.number().int().nullable().optional(),
  type: nullableString,
  reference: nullableString,
})

/** A note authored on the camp booking. `source:'crm'` marks notes the CRM
 *  itself pushed (so we skip re-importing our own echo). */
export const BookingNote = z.object({
  id: z.string().min(1),
  author: nullableString,
  body: nullableString,
  created_at: nullableString,
  source: nullableString,
})
export type BookingNote = z.infer<typeof BookingNote>

export const BookingResource = z.object({
  id: z.string().min(1),
  status: nullableString,
  booking_type: nullableString,
  camp_id: nullableString,
  camp_name: nullableString,
  /** The assigned camp's season start date — year fallback for bookings with
   *  no dates of their own (e.g. Stripe auto-creates before camp assignment). */
  camp_start_date: nullableString,
  subject: nullableString,
  programme_type: nullableString,
  week_number: z.number().int().nullable().optional(),
  week_label: nullableString,
  start_date: nullableString,
  end_date: nullableString,
  days_booked: z.number().int().nullable().optional(),
  multiple_weeks: z.boolean().nullable().optional(),
  booked_weeks: z.array(z.unknown()).nullable().optional(),
  with_accommodation: z.boolean().nullable().optional(),
  with_transfer: z.boolean().nullable().optional(),
  /** The camp's `students.id` for the attendee — the CRM stores this as the
   *  write-back linkage so a CRM edit can target the right camp student. */
  student_id: nullableString,
  /** Every camp the linked student is enrolled in, primary first. Mirrors the
   *  camp's `student_enrolments`; editable via PUT .../:id/camps. Optional —
   *  older camp deploys omit it. */
  enrolled_camp_ids: z.array(z.string()).nullable().optional(),
  student: BookingStudent.nullable().optional(),
  guardian: BookingPerson.nullable().optional(),
  payment: BookingPayment.nullable().optional(),
  agent_name: nullableString,
  notes: nullableString,
  created_at: nullableString,
  updated_at: nullableString,
  notes_log: z.array(BookingNote).nullable().optional(),
})
export type BookingResource = z.infer<typeof BookingResource>

export const BookingEventEnvelope = z.object({
  id: z.string().min(1),
  type: BookingEventType,
  occurred_at: nullableString,
  site: z.object({ url: nullableString }).nullable().optional(),
  booking: BookingResource,
})
export type BookingEventEnvelope = z.infer<typeof BookingEventEnvelope>
