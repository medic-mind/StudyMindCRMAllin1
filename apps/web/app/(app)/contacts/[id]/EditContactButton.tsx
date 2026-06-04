// "Edit details" as a slide-over instead of a full-page navigation
// (UI roadmap increment 3). Opens the existing EditContactForm in a right-hand
// drawer so the agent keeps the contact page in view; saving closes + refreshes
// in place. The full /edit page stays as a deep-link fallback.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { SlideOver } from '@/components/ui/slide-over'
import { trpc } from '@/lib/trpc/client'

import { EditContactForm } from './edit/form'

type Kind = 'parent' | 'student' | 'tutor' | 'other'

export function EditContactButton({ contactId }: { contactId: string }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const query = trpc.contact.get.useQuery({ id: contactId }, { enabled: open })
  const c = query.data

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Edit details
      </Button>
      <SlideOver
        open={open}
        onClose={() => setOpen(false)}
        title="Edit contact"
        width="xl"
      >
        {query.isLoading || !c ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          <EditContactForm
            contact={{
              id: c.id,
              kind: (c.kind === 'parent' || c.kind === 'student' || c.kind === 'tutor'
                ? c.kind
                : 'other') as Kind,
              companyIds: c.companies.map((x) => x.id),
              subjectIds: c.subjects.map((x) => x.id),
              subjects: c.subjects,
              firstName: c.firstName,
              lastName: c.lastName,
              pronouns: c.pronouns,
              email: c.email,
              phoneE164: c.phoneE164,
              dateOfBirth: c.dateOfBirth
                ? new Date(c.dateOfBirth).toISOString().slice(0, 10)
                : null,
              jobTitle: c.jobTitle,
              addressLine1: c.addressLine1,
              addressLine2: c.addressLine2,
              city: c.city,
              postcode: c.postcode,
              country: c.country,
              schoolName: c.schoolName,
              yearGroup: c.yearGroup,
              sendStatus: c.sendStatus,
              examTarget: c.examTarget,
              preferredContactMethod: c.preferredContactMethod,
              timezone: c.timezone,
              referralSource: c.referralSource,
              mailchimpEmail: c.mailchimpEmail,
              notes: c.notes,
            }}
            onSaved={() => {
              setOpen(false)
              void query.refetch()
              router.refresh()
            }}
          />
        )}
      </SlideOver>
    </>
  )
}
