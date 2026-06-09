// Edit Contact (full profile). RSC fetches the existing contact then hands
// it to the client form. CLAUDE.md §26, §20 (server enforces; UI follows).

import { notFound } from 'next/navigation'

import { createServerCaller } from '@/lib/trpc/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { EditContactForm } from './form'

export const dynamic = 'force-dynamic'

export default async function EditContactPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const caller = await createServerCaller()
  let contact
  try {
    contact = await caller.contact.get({ id })
  } catch {
    notFound()
  }
  if (!contact) notFound()

  return (
    <>
      <PageHeader
        title={`Edit ${contact.displayName}`}
        subtitle="Update the profile and contact details"
        breadcrumbs={[
          { label: 'Contacts', href: '/contacts' },
          { label: contact.displayName, href: `/contacts/${contact.id}` },
          { label: 'Edit', href: `/contacts/${contact.id}/edit` },
        ]}
      />
      <PageBody>
        <EditContactForm
          contact={{
            id: contact.id,
            // 'unclassified' is the neutral default; the legacy 'la_caseworker'
            // value is retired from the UI and falls back to 'other'.
            kind:
              contact.kind === 'parent' ||
              contact.kind === 'student' ||
              contact.kind === 'tutor' ||
              contact.kind === 'unclassified' ||
              contact.kind === 'other'
                ? contact.kind
                : 'other',
            companyIds: contact.companies.map((c) => c.id),
            subjectIds: contact.subjects.map((s) => s.id),
            subjects: contact.subjects,
            preferredContactMethod: contact.preferredContactMethod,
            timezone: contact.timezone,
            referralSource: contact.referralSource,
            examTarget: contact.examTarget,
            firstName: contact.firstName,
            lastName: contact.lastName,
            pronouns: contact.pronouns,
            email: contact.email,
            phoneE164: contact.phoneE164,
            dateOfBirth: contact.dateOfBirth
              ? contact.dateOfBirth.toISOString().slice(0, 10)
              : null,
            jobTitle: contact.jobTitle,
            addressLine1: contact.addressLine1,
            addressLine2: contact.addressLine2,
            city: contact.city,
            postcode: contact.postcode,
            country: contact.country,
            schoolName: contact.schoolName,
            yearGroup: contact.yearGroup,
            sendStatus: contact.sendStatus,
            mailchimpEmail: contact.mailchimpEmail,
            notes: contact.notes,
          }}
        />
      </PageBody>
    </>
  )
}
