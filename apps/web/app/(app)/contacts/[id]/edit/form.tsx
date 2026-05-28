'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import { trpc } from '@/lib/trpc/client'

type SendStatus = 'none' | 'send_support' | 'ehcp_in_place' | 'ehcp_in_progress' | 'other'

interface InitialContact {
  id: string
  kind: 'parent' | 'student' | 'tutor' | 'la_caseworker' | 'other'
  firstName: string | null
  lastName: string | null
  pronouns: string | null
  email: string | null
  phoneE164: string | null
  dateOfBirth: string | null // YYYY-MM-DD
  jobTitle: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postcode: string | null
  country: string | null
  schoolName: string | null
  yearGroup: string | null
  sendStatus: SendStatus | null
  mailchimpEmail: string | null
  notes: string | null
}

interface FormState {
  firstName: string
  lastName: string
  pronouns: string
  email: string
  phoneE164: string
  dateOfBirth: string
  jobTitle: string
  addressLine1: string
  addressLine2: string
  city: string
  postcode: string
  country: string
  schoolName: string
  yearGroup: string
  sendStatus: '' | SendStatus
  mailchimpEmail: string
  notes: string
}

function emptyToNull(s: string): string | null {
  const t = s.trim()
  return t.length > 0 ? t : null
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  )
}

export function EditContactForm({ contact }: { contact: InitialContact }) {
  const router = useRouter()
  const [form, setForm] = useState<FormState>({
    firstName: contact.firstName ?? '',
    lastName: contact.lastName ?? '',
    pronouns: contact.pronouns ?? '',
    email: contact.email ?? '',
    phoneE164: contact.phoneE164 ?? '',
    dateOfBirth: contact.dateOfBirth ?? '',
    jobTitle: contact.jobTitle ?? '',
    addressLine1: contact.addressLine1 ?? '',
    addressLine2: contact.addressLine2 ?? '',
    city: contact.city ?? '',
    postcode: contact.postcode ?? '',
    country: contact.country ?? '',
    schoolName: contact.schoolName ?? '',
    yearGroup: contact.yearGroup ?? '',
    sendStatus: contact.sendStatus ?? '',
    mailchimpEmail: contact.mailchimpEmail ?? '',
    notes: contact.notes ?? '',
  })

  const update = trpc.contact.update.useMutation({
    onSuccess: () => {
      toast.success('Contact updated')
      router.push(`/contacts/${contact.id}`)
      router.refresh()
    },
    onError: (err) => {
      toast.error(err.message ?? 'Could not save changes')
    },
  })

  const set =
    <K extends keyof FormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value as FormState[K] }))

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    update.mutate({
      id: contact.id,
      firstName: emptyToNull(form.firstName),
      lastName: emptyToNull(form.lastName),
      pronouns: emptyToNull(form.pronouns),
      email: emptyToNull(form.email),
      phoneE164: emptyToNull(form.phoneE164),
      dateOfBirth: form.dateOfBirth ? new Date(form.dateOfBirth) : null,
      jobTitle: emptyToNull(form.jobTitle),
      addressLine1: emptyToNull(form.addressLine1),
      addressLine2: emptyToNull(form.addressLine2),
      city: emptyToNull(form.city),
      postcode: emptyToNull(form.postcode),
      country: emptyToNull(form.country),
      schoolName: emptyToNull(form.schoolName),
      yearGroup: emptyToNull(form.yearGroup),
      sendStatus: form.sendStatus === '' ? null : form.sendStatus,
      mailchimpEmail: emptyToNull(form.mailchimpEmail),
      notes: emptyToNull(form.notes),
    })
  }

  const showStudentFields = contact.kind === 'student'
  const showJobTitle =
    contact.kind === 'tutor' ||
    contact.kind === 'la_caseworker' ||
    contact.kind === 'other'

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <Section title="Identity">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="firstName">First name</Label>
            <Input id="firstName" value={form.firstName} onChange={set('firstName')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lastName">Last name</Label>
            <Input id="lastName" value={form.lastName} onChange={set('lastName')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pronouns">Pronouns</Label>
            <Input id="pronouns" value={form.pronouns} onChange={set('pronouns')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dateOfBirth">Date of birth</Label>
            <Input
              id="dateOfBirth"
              type="date"
              value={form.dateOfBirth}
              onChange={set('dateOfBirth')}
            />
          </div>
        </div>
      </Section>

      <Section title="Contact details">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={form.email} onChange={set('email')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phoneE164">Phone (E.164)</Label>
            <Input
              id="phoneE164"
              value={form.phoneE164}
              onChange={set('phoneE164')}
              placeholder="+447700900123"
            />
          </div>
          {showJobTitle && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="jobTitle">Job title</Label>
              <Input id="jobTitle" value={form.jobTitle} onChange={set('jobTitle')} />
            </div>
          )}
        </div>
      </Section>

      <Section title="Address">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="addressLine1">Address line 1</Label>
            <Input id="addressLine1" value={form.addressLine1} onChange={set('addressLine1')} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="addressLine2">Address line 2</Label>
            <Input id="addressLine2" value={form.addressLine2} onChange={set('addressLine2')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="city">City / town</Label>
            <Input id="city" value={form.city} onChange={set('city')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="postcode">Postcode</Label>
            <Input id="postcode" value={form.postcode} onChange={set('postcode')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="country">Country</Label>
            <Input id="country" value={form.country} onChange={set('country')} />
          </div>
        </div>
      </Section>

      {showStudentFields && (
        <Section title="Education">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schoolName">School</Label>
              <Input id="schoolName" value={form.schoolName} onChange={set('schoolName')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="yearGroup">Year group</Label>
              <Input id="yearGroup" value={form.yearGroup} onChange={set('yearGroup')} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sendStatus">SEND status</Label>
              <Select id="sendStatus" value={form.sendStatus} onChange={set('sendStatus')}>
                <option value="">Not set</option>
                <option value="none">No SEND</option>
                <option value="send_support">SEND support</option>
                <option value="ehcp_in_place">EHCP in place</option>
                <option value="ehcp_in_progress">EHCP in progress</option>
                <option value="other">Other</option>
              </Select>
            </div>
          </div>
        </Section>
      )}

      <Section title="Marketing">
        <div className="space-y-1.5">
          <Label htmlFor="mailchimpEmail">Mailchimp audience email</Label>
          <Input
            id="mailchimpEmail"
            type="email"
            value={form.mailchimpEmail}
            onChange={set('mailchimpEmail')}
          />
        </div>
      </Section>

      <Section title="Internal notes">
        <Textarea id="notes" rows={4} value={form.notes} onChange={set('notes')} />
      </Section>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Link
          href={`/contacts/${contact.id}`}
          className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-neutral-600 hover:text-neutral-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
