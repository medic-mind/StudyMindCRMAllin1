'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import { trpc } from '@/lib/trpc/client'

// Controlled form (not RHF) so the dateOfBirth / optional-string normalisation
// is explicit. The server is the source of truth for validation.

interface FormState {
  kind: 'parent' | 'student' | 'tutor' | 'la_caseworker' | 'other'
  companyId: string
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
  sendStatus: '' | 'none' | 'send_support' | 'ehcp_in_place' | 'ehcp_in_progress' | 'other'
  mailchimpEmail: string
  notes: string
}

const EMPTY: FormState = {
  kind: 'parent',
  companyId: '',
  firstName: '',
  lastName: '',
  pronouns: '',
  email: '',
  phoneE164: '',
  dateOfBirth: '',
  jobTitle: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  postcode: '',
  country: '',
  schoolName: '',
  yearGroup: '',
  sendStatus: '',
  mailchimpEmail: '',
  notes: '',
}

function clean(s: string): string | undefined {
  const t = s.trim()
  return t.length > 0 ? t : undefined
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

export function NewContactForm() {
  const router = useRouter()
  const [form, setForm] = useState<FormState>(EMPTY)
  const companies = trpc.company.pickList.useQuery()
  const create = trpc.contact.create.useMutation({
    onSuccess: ({ id }) => {
      toast.success('Contact created')
      router.push(`/contacts/${id}`)
    },
    onError: (err) => {
      toast.error(err.message ?? 'Could not create contact')
    },
  })

  const set =
    <K extends keyof FormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value as FormState[K] }))

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const dob = form.dateOfBirth ? new Date(form.dateOfBirth) : undefined
    create.mutate({
      kind: form.kind,
      companyId: form.companyId === '' ? undefined : form.companyId,
      firstName: clean(form.firstName),
      lastName: clean(form.lastName),
      pronouns: clean(form.pronouns),
      email: clean(form.email),
      phoneE164: clean(form.phoneE164),
      dateOfBirth: dob,
      jobTitle: clean(form.jobTitle),
      addressLine1: clean(form.addressLine1),
      addressLine2: clean(form.addressLine2),
      city: clean(form.city),
      postcode: clean(form.postcode),
      country: clean(form.country),
      schoolName: clean(form.schoolName),
      yearGroup: clean(form.yearGroup),
      sendStatus: form.sendStatus === '' ? undefined : form.sendStatus,
      mailchimpEmail: clean(form.mailchimpEmail),
      notes: clean(form.notes),
    })
  }

  const showStudentFields = form.kind === 'student'

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <Section title="Identity" description="Who is this contact?">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="kind">Role</Label>
            <Select id="kind" value={form.kind} onChange={set('kind')}>
              <option value="parent">Parent</option>
              <option value="student">Student</option>
              <option value="tutor">Tutor</option>
              <option value="la_caseworker">LA caseworker</option>
              <option value="other">Other</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="companyId">Company</Label>
            <Select
              id="companyId"
              value={form.companyId}
              onChange={set('companyId')}
              disabled={companies.isLoading}
            >
              <option value="">Not set</option>
              {(companies.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
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
            <Input
              id="pronouns"
              value={form.pronouns}
              onChange={set('pronouns')}
              placeholder="e.g. they/them"
            />
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
          {(form.kind === 'tutor' ||
            form.kind === 'la_caseworker' ||
            form.kind === 'other') && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="jobTitle">Job title</Label>
              <Input id="jobTitle" value={form.jobTitle} onChange={set('jobTitle')} />
            </div>
          )}
        </div>
      </Section>

      <Section title="Address" description="Optional postal address.">
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
            <Input
              id="country"
              value={form.country}
              onChange={set('country')}
              placeholder="United Kingdom"
            />
          </div>
        </div>
      </Section>

      {showStudentFields && (
        <Section
          title="Education"
          description="School + year group + SEND status — fill what's known."
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schoolName">School</Label>
              <Input id="schoolName" value={form.schoolName} onChange={set('schoolName')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="yearGroup">Year group</Label>
              <Input
                id="yearGroup"
                value={form.yearGroup}
                onChange={set('yearGroup')}
                placeholder="e.g. Year 9"
              />
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

      <Section
        title="Marketing"
        description="Optional. Stored only for reference; Mailchimp push is a separate action."
      >
        <div className="space-y-1.5">
          <Label htmlFor="mailchimpEmail">Mailchimp audience email</Label>
          <Input
            id="mailchimpEmail"
            type="email"
            value={form.mailchimpEmail}
            onChange={set('mailchimpEmail')}
            placeholder="Defaults to Email if blank"
          />
        </div>
      </Section>

      <Section title="Internal notes">
        <Textarea
          id="notes"
          rows={4}
          value={form.notes}
          onChange={set('notes')}
          placeholder="Anything the next agent needs to know."
        />
      </Section>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create contact'}
        </Button>
      </div>
    </form>
  )
}
