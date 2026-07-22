// Domain-mapped types for the StudyMind booking site (student-centric, ADR 0029).
//
// The booking site is the source of truth for students, lessons, the
// hours-balance ledger and credits (CLAUDE.md §15). The wire contract this
// module maps from is documented in docs/api/booking-pull-api.md. We never let
// raw booking-site shapes leak past this module; the mappers normalise and
// (for the one true enum, credit kind) fail closed on unknown values (§8).

// -----------------------------------------------------------------------------
// Pagination envelope (keyset, incremental). See docs/api/booking-pull-api.md §2.4.
// -----------------------------------------------------------------------------

export interface Page<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
  /** Rows on this page that failed to map (deterministically bad data) and were
   *  skipped so one poison row can't freeze the whole resource pull (§8). */
  skipped?: number
}

// -----------------------------------------------------------------------------
// Webhook envelope — kept for the Phase-2 push stub (ADR 0007). Pull is live.
// -----------------------------------------------------------------------------

export interface BookingEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}

// -----------------------------------------------------------------------------
// Credit kind — the one closed enum (the booking "Adjust Credits" panel has a
// fixed set of four products). Maps to the Postgres `BookingCreditKind` enum,
// so we fail closed on anything unexpected (CLAUDE.md §8, §19).
// -----------------------------------------------------------------------------

export type BookingCreditKind = 'online_mmi' | 'in_person_mmi' | 'live_day' | 'in_person_live_day'

const CREDIT_KINDS: ReadonlySet<BookingCreditKind> = new Set([
  'online_mmi',
  'in_person_mmi',
  'live_day',
  'in_person_live_day',
])

export function mapCreditKind(raw: string): BookingCreditKind {
  const normalised = normaliseEnumString(raw)
  if (CREDIT_KINDS.has(normalised as BookingCreditKind)) {
    return normalised as BookingCreditKind
  }
  throw new Error(`Unknown booking credit kind from provider: ${raw}`)
}

// Lesson status / payment and ledger `type` are stored as normalised raw text
// (not Postgres enums) until the booking team confirms the full value sets
// (docs/api/booking-pull-api.md §2.3). These constants document what we have
// seen in the admin and are used by downstream derivations — never to reject a
// sync row, so a new value never blocks the pull.
export const KNOWN_LESSON_STATUSES = ['active', 'cancelled'] as const
export const KNOWN_LESSON_PAYMENTS = ['charged', 'no_fee'] as const

// -----------------------------------------------------------------------------
// Normalisation helpers.
// -----------------------------------------------------------------------------

/** Lowercase + collapse spaces/hyphens to underscores. Never throws. */
export function normaliseEnumString(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

function toDate(raw: string): Date {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date from booking site: ${raw}`)
  return d
}

function toOptionalDate(raw: string | null | undefined): Date | null {
  if (raw == null || raw === '') return null
  return toDate(raw)
}

function trimmedOrNull(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const t = raw.trim()
  return t === '' ? null : t
}

/** Split a single "Full Name" into first + rest. Used only when the booking
 *  site does not already give us split names. */
export function splitFullName(full: string | null | undefined): {
  firstName: string | null
  lastName: string | null
} {
  const t = (full ?? '').trim()
  if (t === '') return { firstName: null, lastName: null }
  const parts = t.split(/\s+/u)
  if (parts.length === 1) return { firstName: parts[0] ?? null, lastName: null }
  return { firstName: parts[0] ?? null, lastName: parts.slice(1).join(' ') || null }
}

function num(raw: number | null | undefined): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

// -----------------------------------------------------------------------------
// Students.
// -----------------------------------------------------------------------------

export interface RawStudentBalance {
  hours_added?: number | null
  hours_used?: number | null
  hours_deducted?: number | null
  hours_remaining?: number | null
  premium_hours_added?: number | null
  premium_hours_used?: number | null
  premium_hours_deducted?: number | null
  premium_hours_remaining?: number | null
  next_expiry_at?: string | null
}

export interface RawStudentCredits {
  online_mmi?: number | null
  in_person_mmi?: number | null
  live_day?: number | null
  in_person_live_day?: number | null
}

export interface RawStudent {
  uuid: string
  id: number
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  email?: string | null
  phone?: string | null
  date_of_birth?: string | null
  country?: string | null
  receive_marketing_emails?: boolean | null
  added_by_agent?: boolean | null
  has_guardian?: boolean | null
  guardian_name?: string | null
  guardian_phone?: string | null
  guardian_email?: string | null
  labels?: string[] | null
  balance?: RawStudentBalance | null
  credits?: RawStudentCredits | null
  registered_at?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface BookingBalanceSummary {
  hoursAdded: number
  hoursUsed: number
  hoursDeducted: number
  hoursRemaining: number
  premiumHoursAdded: number
  premiumHoursUsed: number
  premiumHoursDeducted: number
  premiumHoursRemaining: number
  nextExpiryAt: Date | null
}

export interface BookingCreditBalances {
  onlineMmi: number
  inPersonMmi: number
  liveDay: number
  inPersonLiveDay: number
}

export interface BookingStudent {
  uuid: string
  legacyId: number
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  dateOfBirth: Date | null
  country: string | null
  receiveMarketingEmails: boolean | null
  addedByAgent: boolean | null
  hasGuardian: boolean | null
  guardianName: string | null
  guardianPhoneE164: string | null
  guardianEmail: string | null
  labels: string[]
  balance: BookingBalanceSummary
  credits: BookingCreditBalances
  registeredAt: Date | null
  updatedAt: Date
  deletedAt: Date | null
}

function mapBalance(raw: RawStudentBalance | null | undefined): BookingBalanceSummary {
  const b = raw ?? {}
  return {
    hoursAdded: num(b.hours_added),
    hoursUsed: num(b.hours_used),
    hoursDeducted: num(b.hours_deducted),
    hoursRemaining: num(b.hours_remaining),
    premiumHoursAdded: num(b.premium_hours_added),
    premiumHoursUsed: num(b.premium_hours_used),
    premiumHoursDeducted: num(b.premium_hours_deducted),
    premiumHoursRemaining: num(b.premium_hours_remaining),
    nextExpiryAt: toOptionalDate(b.next_expiry_at),
  }
}

function mapCredits(raw: RawStudentCredits | null | undefined): BookingCreditBalances {
  const c = raw ?? {}
  return {
    onlineMmi: num(c.online_mmi),
    inPersonMmi: num(c.in_person_mmi),
    liveDay: num(c.live_day),
    inPersonLiveDay: num(c.in_person_live_day),
  }
}

export function mapStudent(raw: RawStudent): BookingStudent {
  const split =
    raw.first_name || raw.last_name
      ? { firstName: trimmedOrNull(raw.first_name), lastName: trimmedOrNull(raw.last_name) }
      : splitFullName(raw.full_name)

  return {
    uuid: raw.uuid,
    legacyId: raw.id,
    firstName: split.firstName,
    lastName: split.lastName,
    email: trimmedOrNull(raw.email),
    phoneE164: trimmedOrNull(raw.phone),
    dateOfBirth: toOptionalDate(raw.date_of_birth),
    country: trimmedOrNull(raw.country),
    receiveMarketingEmails: raw.receive_marketing_emails ?? null,
    addedByAgent: raw.added_by_agent ?? null,
    hasGuardian: raw.has_guardian ?? null,
    guardianName: trimmedOrNull(raw.guardian_name),
    guardianPhoneE164: trimmedOrNull(raw.guardian_phone),
    guardianEmail: trimmedOrNull(raw.guardian_email),
    labels: (raw.labels ?? []).map((l) => l.trim()).filter(Boolean),
    balance: mapBalance(raw.balance),
    credits: mapCredits(raw.credits),
    registeredAt: toOptionalDate(raw.registered_at),
    updatedAt: toDate(raw.updated_at),
    deletedAt: toOptionalDate(raw.deleted_at),
  }
}

// -----------------------------------------------------------------------------
// Lessons.
// -----------------------------------------------------------------------------

export interface RawLesson {
  id: number
  student_uuid: string
  tutor_id?: number | null
  tutor_name?: string | null
  subject?: string | null
  starts_at: string
  ends_at?: string | null
  duration_hours?: number | null
  status: string
  payment?: string | null
  is_trial?: boolean | null
  trial_feedback?: string | null
  trial_feedback_status?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface BookingLessonResource {
  externalId: string
  studentUuid: string
  tutorExternalId: string | null
  tutorName: string | null
  subject: string | null
  startsAt: Date
  endsAt: Date | null
  durationMinutes: number
  status: string
  payment: string | null
  isTrial: boolean
  trialFeedback: string | null
  trialFeedbackStatus: string | null
  updatedAt: Date
  deletedAt: Date | null
}

function durationMinutes(raw: RawLesson, startsAt: Date, endsAt: Date | null): number {
  if (typeof raw.duration_hours === 'number' && Number.isFinite(raw.duration_hours)) {
    return Math.max(0, Math.round(raw.duration_hours * 60))
  }
  if (endsAt) {
    return Math.max(0, Math.round((endsAt.getTime() - startsAt.getTime()) / 60000))
  }
  return 0
}

export function mapLesson(raw: RawLesson): BookingLessonResource {
  const startsAt = toDate(raw.starts_at)
  const endsAt = toOptionalDate(raw.ends_at)
  return {
    externalId: String(raw.id),
    studentUuid: raw.student_uuid,
    tutorExternalId: raw.tutor_id == null ? null : String(raw.tutor_id),
    tutorName: trimmedOrNull(raw.tutor_name),
    subject: raw.subject ? normaliseEnumString(raw.subject) : null,
    startsAt,
    endsAt,
    durationMinutes: durationMinutes(raw, startsAt, endsAt),
    status: normaliseEnumString(raw.status),
    payment: raw.payment ? normaliseEnumString(raw.payment) : null,
    isTrial: raw.is_trial ?? false,
    trialFeedback: trimmedOrNull(raw.trial_feedback),
    trialFeedbackStatus: raw.trial_feedback_status
      ? normaliseEnumString(raw.trial_feedback_status)
      : null,
    updatedAt: toDate(raw.updated_at),
    deletedAt: toOptionalDate(raw.deleted_at),
  }
}

// -----------------------------------------------------------------------------
// Balance (hours) ledger.
// -----------------------------------------------------------------------------

export interface RawBalanceTransaction {
  id: string | number
  student_uuid: string
  hours: number
  is_premium?: boolean | null
  amount_pence?: number | null
  stripe_reference?: string | null
  message?: string | null
  type: string
  admin_id?: number | null
  admin_name?: string | null
  occurred_at: string
  expires_at?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface BookingHoursTxnResource {
  externalId: string
  studentUuid: string
  hours: number
  isPremium: boolean
  amountMinor: number | null
  stripeReference: string | null
  message: string | null
  type: string
  adminExternalId: string | null
  adminName: string | null
  occurredAt: Date
  expiresAt: Date | null
  updatedAt: Date
  deletedAt: Date | null
}

export function mapHoursTransaction(raw: RawBalanceTransaction): BookingHoursTxnResource {
  if (typeof raw.hours !== 'number' || !Number.isFinite(raw.hours)) {
    throw new Error(`Balance transaction ${raw.id} has non-numeric hours`)
  }
  return {
    externalId: String(raw.id),
    studentUuid: raw.student_uuid,
    hours: raw.hours,
    isPremium: raw.is_premium ?? false,
    amountMinor: raw.amount_pence ?? null,
    stripeReference: trimmedOrNull(raw.stripe_reference),
    message: trimmedOrNull(raw.message),
    type: normaliseEnumString(raw.type),
    adminExternalId: raw.admin_id == null ? null : String(raw.admin_id),
    adminName: trimmedOrNull(raw.admin_name),
    occurredAt: toDate(raw.occurred_at),
    expiresAt: toOptionalDate(raw.expires_at),
    updatedAt: toDate(raw.updated_at),
    deletedAt: toOptionalDate(raw.deleted_at),
  }
}

// -----------------------------------------------------------------------------
// Credit ledger.
// -----------------------------------------------------------------------------

export interface RawCreditTransaction {
  id: string | number
  student_uuid: string
  credit_kind: string
  credits: number
  amount_pence?: number | null
  stripe_reference?: string | null
  message?: string | null
  type: string
  admin_id?: number | null
  admin_name?: string | null
  occurred_at: string
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface BookingCreditTxnResource {
  externalId: string
  studentUuid: string
  creditKind: BookingCreditKind
  credits: number
  amountMinor: number | null
  stripeReference: string | null
  message: string | null
  type: string
  adminExternalId: string | null
  adminName: string | null
  occurredAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

export function mapCreditTransaction(raw: RawCreditTransaction): BookingCreditTxnResource {
  if (typeof raw.credits !== 'number' || !Number.isFinite(raw.credits)) {
    throw new Error(`Credit transaction ${raw.id} has non-numeric credits`)
  }
  return {
    externalId: String(raw.id),
    studentUuid: raw.student_uuid,
    creditKind: mapCreditKind(raw.credit_kind),
    credits: raw.credits,
    amountMinor: raw.amount_pence ?? null,
    stripeReference: trimmedOrNull(raw.stripe_reference),
    message: trimmedOrNull(raw.message),
    type: normaliseEnumString(raw.type),
    adminExternalId: raw.admin_id == null ? null : String(raw.admin_id),
    adminName: trimmedOrNull(raw.admin_name),
    occurredAt: toDate(raw.occurred_at),
    updatedAt: toDate(raw.updated_at),
    deletedAt: toOptionalDate(raw.deleted_at),
  }
}
