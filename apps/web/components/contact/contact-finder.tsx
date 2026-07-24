// Shared "find the customer, or add a new one" flow. Search-first: type a name
// / email / phone and matching customers appear instantly beneath the box —
// pick one to resolve them. Genuinely new person? "Add a new contact" expands a
// tidy create form, and a de-dup guard still catches a near-duplicate before
// it's created (CLAUDE.md §3 — never auto-merge). On resolution it calls
// onResolved({ contactId, contactName }) and the parent decides what happens
// next (log a call, log a complaint, …). Used by /call-summaries and the
// Log-complaint modal so both behave identically.

'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { MailIcon, PhoneIcon, SearchIcon, UserPlusIcon, XIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

export interface ResolvedContact {
  contactId: string
  contactName: string
}

type Kind = 'unclassified' | 'parent' | 'student' | 'tutor' | 'other'

const KIND_LABEL: Record<string, string> = {
  unclassified: 'Unclassified',
  parent: 'Parent',
  student: 'Student',
  tutor: 'Tutor',
  other: 'Other',
}

function clean(s: string): string | undefined {
  const t = s.trim()
  return t.length > 0 ? t : undefined
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export interface ContactFinderProps {
  onResolved: (r: ResolvedContact) => void
  /** Focus the search box on mount. Default true. */
  autoFocus?: boolean
  /** CTA on the create form's submit button. Default "Create contact →". */
  createCta?: string
  searchPlaceholder?: string
}

export function ContactFinder({
  onResolved,
  autoFocus = true,
  createCta = 'Create contact →',
  searchPlaceholder = 'Search by name, email or phone…',
}: ContactFinderProps) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  const ready = debounced.length >= 2
  const results = trpc.contact.list.useQuery(
    { q: debounced, limit: 8 },
    { enabled: ready && !creating, staleTime: 10_000 },
  )
  const items = results.data?.items ?? []

  if (creating) {
    return (
      <CreateContact
        initialQuery={q}
        createCta={createCta}
        onCancel={() => setCreating(false)}
        onCreated={onResolved}
      />
    )
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <SearchIcon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
        />
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search customer"
          className="h-11 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm shadow-sm transition-colors placeholder:text-neutral-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
        />
      </div>

      {/* Results — right under the box, where you're already looking. */}
      {ready ? (
        <div className="overflow-hidden rounded-lg border border-neutral-200">
          {results.isLoading ? (
            <p className="px-3 py-6 text-center text-sm text-neutral-400">Searching…</p>
          ) : items.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-sm text-neutral-600">No customer matches “{debounced}”.</p>
              <Button type="button" size="sm" className="mt-2" onClick={() => setCreating(true)}>
                <UserPlusIcon size={14} /> Add a new contact
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onResolved({ contactId: c.id, contactName: c.displayName })}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-primary-50/60"
                  >
                    <Avatar name={c.displayName} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-neutral-900">
                        {c.displayName}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-3 text-xs text-neutral-500">
                        {c.email ? (
                          <span className="inline-flex items-center gap-1 truncate">
                            <MailIcon size={11} /> {c.email}
                          </span>
                        ) : null}
                        {c.phoneE164 ? (
                          <span className="inline-flex items-center gap-1">
                            <PhoneIcon size={11} /> {c.phoneE164}
                          </span>
                        ) : null}
                        {!c.email && !c.phoneE164 ? 'No contact details' : null}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
                      {KIND_LABEL[c.kind] ?? c.kind}
                    </span>
                    <span aria-hidden className="shrink-0 text-primary-600">
                      →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-neutral-400">Type at least 2 characters to search.</p>
      )}

      {/* Always-available escape hatch for a brand-new person. */}
      {ready && items.length > 0 ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-700 hover:underline"
        >
          <UserPlusIcon size={14} /> Not here? Add a new contact
        </button>
      ) : null}
    </div>
  )
}

function CreateContact({
  initialQuery,
  createCta,
  onCancel,
  onCreated,
}: {
  initialQuery: string
  createCta: string
  onCancel: () => void
  onCreated: (r: ResolvedContact) => void
}) {
  // Prefill from whatever they were searching: an email-looking query lands in
  // Email, otherwise it seeds the name. (Phone formats vary too much to safely
  // pre-compose, so we leave that to the proper input.)
  const seed = initialQuery.trim()
  const seedIsEmail = EMAIL_RE.test(seed)
  const seedNameParts = !seedIsEmail && /[a-z]/i.test(seed) ? seed.split(/\s+/) : []

  const [kind, setKind] = useState<Kind>('unclassified')
  const [firstName, setFirstName] = useState(seedNameParts[0] ?? '')
  const [lastName, setLastName] = useState(seedNameParts.slice(1).join(' '))
  const [email, setEmail] = useState(seedIsEmail ? seed : '')
  const [phone, setPhone] = useState('')

  // De-dup guard: as the create fields fill, check we're not about to make a
  // duplicate. Surfaced inline, above the Create button (never auto-merges).
  const [dq, setDq] = useState({ name: '', email: '', phone: '' })
  useEffect(() => {
    const name = `${firstName} ${lastName}`.trim()
    const t = setTimeout(() => setDq({ name, email: email.trim(), phone: phone.trim() }), 300)
    return () => clearTimeout(t)
  }, [firstName, lastName, email, phone])
  const dupReady = Boolean(dq.name || dq.email || dq.phone)
  const dupQuery = trpc.callSummaries.findContactCandidates.useQuery(
    { name: dq.name || undefined, email: dq.email || undefined, phone: dq.phone || undefined },
    { enabled: dupReady, staleTime: 10_000 },
  )
  const candidates = dupQuery.data?.candidates ?? []

  const create = trpc.contact.create.useMutation()

  async function submit() {
    if (!firstName.trim() && !lastName.trim() && !email.trim() && !phone.trim()) {
      toast.error('Add at least a name, email, or phone.')
      return
    }
    try {
      const { id } = await create.mutateAsync({
        kind,
        firstName: clean(firstName),
        lastName: clean(lastName),
        email: clean(email),
        phoneE164: clean(phone),
      })
      const name = `${firstName} ${lastName}`.trim() || email.trim() || phone.trim() || 'New contact'
      toast.success('Contact created')
      onCreated({ contactId: id, contactName: name })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create contact')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-neutral-800">New contact</p>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800"
        >
          <XIcon size={13} /> Back to search
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="First name" htmlFor="cf-first">
          <Input id="cf-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
        </Field>
        <Field label="Last name" htmlFor="cf-last">
          <Input id="cf-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="cf-email">
          <Input
            id="cf-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
          />
        </Field>
        <Field label="Phone" htmlFor="cf-phone">
          <PhoneInput id="cf-phone" value={phone} onChange={setPhone} />
        </Field>
        <Field label="Role" htmlFor="cf-kind">
          <Select id="cf-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="unclassified">Unclassified</option>
            <option value="parent">Parent</option>
            <option value="student">Student</option>
            <option value="tutor">Tutor</option>
            <option value="other">Other</option>
          </Select>
        </Field>
      </div>

      {/* Duplicate safety net */}
      {dupReady && candidates.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3">
          <p className="text-xs font-medium text-amber-900">
            {dupQuery.data?.match
              ? 'This looks like someone already in the CRM — use them instead of creating a duplicate:'
              : 'Possible existing contacts — use one to avoid a duplicate:'}
          </p>
          <ul className="mt-2 space-y-1">
            {candidates.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5"
              >
                <Avatar name={c.name} size={24} />
                <span className="text-sm font-medium text-neutral-800">{c.name}</span>
                {c.email ? <span className="text-xs text-neutral-500">{c.email}</span> : null}
                {c.phoneE164 ? <span className="text-xs text-neutral-500">{c.phoneE164}</span> : null}
                <button
                  type="button"
                  onClick={() => onCreated({ contactId: c.id, contactName: c.name })}
                  className="ml-auto text-xs font-semibold text-primary-700 hover:underline"
                >
                  Use →
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="button" onClick={submit} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : createCta}
        </Button>
        <button type="button" onClick={onCancel} className="text-sm text-neutral-500 hover:underline">
          Cancel
        </button>
      </div>
    </div>
  )
}
