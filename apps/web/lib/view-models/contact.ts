// Contact view-models. Constructed in RSC, never expose raw rows to the client.
// See CLAUDE.md Section 26.

import type {
  CompanyRef,
  ContactKind,
  ContactPreferredContactMethod,
  ContactSendStatus,
  ContactSummary,
  SubjectRef,
} from '@studymind/core/contact'
import { displayNameOf } from '@studymind/core/contact'

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

interface ContactSummaryRow extends ContactRow {
  familyMembers: Array<{ family: { id: string; name: string | null } | null }>
  interactions: Array<{ occurredAt: Date }>
  companies: ContactCompanyJoin[]
}

export function toContactSummary(row: ContactSummaryRow): ContactSummary {
  const family = row.familyMembers[0]?.family ?? null
  const last = row.interactions[0]?.occurredAt ?? null
  return {
    id: row.id,
    kind: row.kind,
    displayName: displayNameOf(row),
    email: row.email,
    phoneE164: row.phoneE164,
    familyId: family?.id ?? null,
    familyName: family?.name ?? null,
    lastInteractionAt: last,
    companies: row.companies.map((cc) => cc.company),
  }
}

interface ContactDetailRow extends ContactRow {
  familyMembers: Array<{ family: { id: string; name: string | null } | null }>
  safeguardingFlags: Array<{ state: string }>
  companies: ContactCompanyJoin[]
  subjects: ContactSubjectJoin[]
}

export function toContactDetail(row: ContactDetailRow): ContactDetailViewModel {
  const family = row.familyMembers[0]?.family ?? null
  const hasFlag = row.safeguardingFlags.some(
    (f) => f.state === 'concern_logged' || f.state === 'restricted_access',
  )
  const isRestricted = row.safeguardingFlags.some(
    (f) => f.state === 'restricted_access',
  )
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
    hasSafeguardingFlag: hasFlag,
    isRestricted,
    family,
    createdAt: row.createdAt,
  }
}
