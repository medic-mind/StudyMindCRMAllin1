// Contact view-models. Constructed in RSC, never expose raw rows to the client.
// See CLAUDE.md Section 26.

import type {
  CompanyRef,
  ContactBookingStatus,
  ContactKind,
  ContactPreferredContactMethod,
  ContactSendStatus,
  ContactSummary,
  SubjectRef,
} from '@studymind/core/contact'
import { deriveHoursRisk, displayNameOf } from '@studymind/core/contact'
import type { ContactCommsCounts } from '@studymind/core/stats'

export type { ContactSummary } from '@studymind/core/contact'

export interface ContactDetailViewModel {
  id: string
  kind: ContactKind
  displayName: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  dateOfBirth: Date | null
  isMinor: boolean
  notes: string | null
  // Extended profile.
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postcode: string | null
  country: string | null
  schoolName: string | null
  yearGroup: string | null
  sendStatus: ContactSendStatus | null
  jobTitle: string | null
  pronouns: string | null
  mailchimpEmail: string | null
  preferredContactMethod: ContactPreferredContactMethod | null
  timezone: string | null
  referralSource: string | null
  examTarget: string | null
  /** Many-to-many sister brands. */
  companies: CompanyRef[]
  /** Tutoring subjects. */
  subjects: SubjectRef[]
  /** Enquiry types from the contact's web enquiries ("Tutoring", "Summer
   * Camp", "Online Courses", …) — Lead.categories, latest-first. */
  enquiryTypes: string[]
  hasSafeguardingFlag: boolean
  isRestricted: boolean
  family: { id: string; name: string | null } | null
  createdAt: Date
}

interface ContactRow {
  id: string
  kind: ContactKind
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  dateOfBirth: Date | null
  isMinor: boolean
  notes: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postcode: string | null
  country: string | null
  schoolName: string | null
  yearGroup: string | null
  sendStatus: ContactSendStatus | null
  jobTitle: string | null
  pronouns: string | null
  mailchimpEmail: string | null
  preferredContactMethod: ContactPreferredContactMethod | null
  timezone: string | null
  referralSource: string | null
  examTarget: string | null
  createdAt: Date
}

interface ContactCompanyJoin {
  company: { id: string; name: string; slug: string; color: string | null }
}

interface ContactSubjectJoin {
  subject: { id: string; name: string }
}

interface ContactLabelJoin {
  label: { id: string; name: string; color: string | null }
}

interface ContactSummaryRow extends ContactRow {
  familyMembers: Array<{ family: { id: string; name: string | null } | null }>
  interactions: Array<{ occurredAt: Date }>
  companies: ContactCompanyJoin[]
  labels?: ContactLabelJoin[]
  subjects?: ContactSubjectJoin[]
  bookingProfile?: {
    hoursRemaining: { toNumber(): number } | number | null
    nextHoursExpiryAt: Date | null
  } | null
  createdAt: Date
  bookingStatus: ContactBookingStatus
  hoursBooked: number | null
  hoursDelivered: number | null
  lastLessonAt: Date | null
  amountSpentMinor: number | null
}

const NO_COUNTS: ContactCommsCounts = { callCount: 0, emailCount: 0, textCount: 0 }

/** Prisma Decimal | number | null → number | null. */
function decToNumber(v: { toNumber(): number } | number | null | undefined): number | null {
  if (v == null) return null
  return typeof v === 'number' ? v : v.toNumber()
}

export function toContactSummary(
  row: ContactSummaryRow,
  counts: ContactCommsCounts = NO_COUNTS,
  now: Date = new Date(),
  complaintCount = 0,
  enquiryTypes: string[] = [],
): ContactSummary {
  const family = row.familyMembers[0]?.family ?? null
  const last = row.interactions[0]?.occurredAt ?? null
  const hoursRemaining = decToNumber(row.bookingProfile?.hoursRemaining)
  const risk = deriveHoursRisk(
    {
      hoursBooked: row.hoursBooked,
      hoursDelivered: row.hoursDelivered,
      hoursRemaining,
      lastLessonAt: row.lastLessonAt,
      nextHoursExpiryAt: row.bookingProfile?.nextHoursExpiryAt ?? null,
    },
    now,
  )
  return {
    id: row.id,
    kind: row.kind,
    displayName: displayNameOf(row),
    email: row.email,
    phoneE164: row.phoneE164,
    familyId: family?.id ?? null,
    familyName: family?.name ?? null,
    lastInteractionAt: last,
    createdAt: row.createdAt,
    companies: row.companies.map((cc) => cc.company),
    bookingStatus: row.bookingStatus,
    hoursBooked: row.hoursBooked,
    hoursDelivered: row.hoursDelivered,
    hoursRemaining: hoursRemaining != null ? Math.round(hoursRemaining) : null,
    lastLessonAt: row.lastLessonAt,
    amountSpentMinor: row.amountSpentMinor,
    callCount: counts.callCount,
    emailCount: counts.emailCount,
    textCount: counts.textCount,
    complaintCount,
    labels: (row.labels ?? []).map((l) => l.label),
    subjects: (row.subjects ?? []).map((s) => s.subject),
    enquiryTypes,
    riskLevel: risk.level,
    riskScore: risk.score,
  }
}

interface ContactDetailRow extends ContactRow {
  familyMembers: Array<{ family: { id: string; name: string | null } | null }>
  safeguardingFlags: Array<{ state: string }>
  companies: ContactCompanyJoin[]
  subjects: ContactSubjectJoin[]
}

export function toContactDetail(
  row: ContactDetailRow,
  enquiryTypes: string[] = [],
): ContactDetailViewModel {
  const family = row.familyMembers[0]?.family ?? null
  const hasFlag = row.safeguardingFlags.some(
    (f) => f.state === 'concern_logged' || f.state === 'restricted_access',
  )
  const isRestricted = row.safeguardingFlags.some((f) => f.state === 'restricted_access')
  return {
    id: row.id,
    kind: row.kind,
    displayName: displayNameOf(row),
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phoneE164: row.phoneE164,
    dateOfBirth: row.dateOfBirth,
    isMinor: row.isMinor,
    notes: row.notes,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    postcode: row.postcode,
    country: row.country,
    schoolName: row.schoolName,
    yearGroup: row.yearGroup,
    sendStatus: row.sendStatus,
    jobTitle: row.jobTitle,
    pronouns: row.pronouns,
    mailchimpEmail: row.mailchimpEmail,
    preferredContactMethod: row.preferredContactMethod,
    timezone: row.timezone,
    referralSource: row.referralSource,
    examTarget: row.examTarget,
    companies: row.companies.map((cc) => cc.company),
    subjects: row.subjects.map((cs) => cs.subject),
    enquiryTypes,
    hasSafeguardingFlag: hasFlag,
    isRestricted,
    family,
    createdAt: row.createdAt,
  }
}
