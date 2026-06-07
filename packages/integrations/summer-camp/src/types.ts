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

export const BookingPayment = z.object({
  total_minor: z.number().int().nullable().optional(),
  paid_minor: z.number().int().nullable().optional(),
  type: nullableString,
  reference: nullableString,
})

export const BookingResource = z.object({
  id: z.string().min(1),
  status: nullableString,
  booking_type: nullableString,
  camp_id: nullableString,
  camp_name: nullableString,
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
  student: BookingPerson.nullable().optional(),
  guardian: BookingPerson.nullable().optional(),
  payment: BookingPayment.nullable().optional(),
  agent_name: nullableString,
  notes: nullableString,
  created_at: nullableString,
  updated_at: nullableString,
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
