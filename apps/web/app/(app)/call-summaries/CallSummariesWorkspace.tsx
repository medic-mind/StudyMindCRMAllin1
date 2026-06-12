// Client island for /call-summaries. Two parts:
//  1. "New call summary" — identify who you spoke to (name / email / phone);
//     a debounced de-dup guard surfaces existing matches so you reuse a
//     contact instead of duplicating it, or create a fresh one. Once a
//     contact is resolved the shared CallSummaryWizard takes over (the same
//     VA-vs-self flow as the contact page).
//  2. A recent-summaries queue so the team can see what's been logged.

'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { CallSummaryWizard } from '@/components/contact/call-summary-wizard'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

type Kind = 'unclassified' | 'parent' | 'student' | 'tutor' | 'other'

function clean(s: string): string | undefined {
  const t = s.trim()
  return t.length > 0 ? t : undefined
}

interface Resolved {
  contactId: string
  contactName: string
}

export function CallSummariesWorkspace() {
  const [resolved, setResolved] = useState<Resolved | null>(null)

  return (
    <div className="space-y-6">
      {resolved ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Call summary for
              </p>
              <p className="text-sm font-semibold text-neutral-900">
                <Link href={`/contacts/${resolved.contactId}`} className="hover:underline">
                  {resolved.contactName}
                </Link>
              </p>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={() => setResolved(null)}>
              ← Someone else
            </Button>
          </div>
          <CallSummaryWizard
            mode="contact"
            contactId={resolved.contactId}
            contactName={resolved.contactName}
          />
        </section>
      ) : (
        <IdentifyContact onResolved={setResolved} />
      )}

      <RecentSummaries />
    </div>
  )
}

function IdentifyContact({ onResolved }: { onResolved: (r: Resolved) => void }) {
  const [kind, setKind] = useState<Kind>('unclassified')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  // Debounce the lookup so we don't query on every keystroke.
  const [debounced, setDebounced] = useState({ name: '', email: '', phone: '' })
  useEffect(() => {
    const name = `${firstName} ${lastName}`.trim()
    const t = setTimeout(() => setDebounced({ name, email: email.trim(), phone: phone.trim() }), 350)
    return () => clearTimeout(t)
  }, [firstName, lastName, email, phone])

  const hasQuery = Boolean(debounced.name || debounced.email || debounced.phone)
  const candidatesQuery = trpc.callSummaries.findContactCandidates.useQuery(
    { name: debounced.name || undefined, email: debounced.email || undefined, phone: debounced.phone || undefined },
    { enabled: hasQuery, staleTime: 10_000 },
  )
  const data = candidatesQuery.data
  const strongMatch = useMemo(
    () =>
      data?.match
        ? data.candidates.find((c) => c.id === data.match!.contactId) ?? null
        : null,
    [data],
  )

  const create = trpc.contact.create.useMutation()

  async function createAndContinue() {
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
      onResolved({ contactId: id, contactName: name })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create contact')
    }
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        New call summary
      </p>
      <p className="mt-0.5 text-sm text-neutral-700">Who did you speak to?</p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="First name" htmlFor="cs-first">
          <Input id="cs-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
        </Field>
        <Field label="Last name" htmlFor="cs-last">
          <Input id="cs-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="cs-email">
          <Input
            id="cs-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
          />
        </Field>
        <Field label="Phone" htmlFor="cs-phone">
          <PhoneInput id="cs-phone" value={phone} onChange={setPhone} />
        </Field>
        <Field label="Role (if creating new)" htmlFor="cs-kind">
          <Select id="cs-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="unclassified">Unclassified</option>
            <option value="parent">Parent</option>
            <option value="student">Student</option>
            <option value="tutor">Tutor</option>
            <option value="other">Other</option>
          </Select>
        </Field>
      </div>

      {/* De-dup guard */}
      {hasQuery ? (
        <div className="mt-3">
          {candidatesQuery.isLoading ? (
            <p className="text-xs text-neutral-500">Checking for an existing contact…</p>
          ) : strongMatch ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50/70 p-3">
              <p className="text-xs font-medium text-emerald-900">
                This looks like an existing contact ({data?.match?.via} match) — log against
                them so it doesn&apos;t duplicate:
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-neutral-900">{strongMatch.name}</span>
                {strongMatch.email ? (
                  <span className="text-xs text-neutral-500">{strongMatch.email}</span>
                ) : null}
                {strongMatch.phoneE164 ? (
                  <span className="text-xs text-neutral-500">{strongMatch.phoneE164}</span>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onResolved({ contactId: strongMatch.id, contactName: strongMatch.name })}
                >
                  Use this contact →
                </Button>
              </div>
            </div>
          ) : (data?.candidates.length ?? 0) > 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3">
              <p className="text-xs font-medium text-amber-900">
                {data?.ambiguous
                  ? 'More than one contact could match — pick the right one (we never merge for you):'
                  : 'Possible existing contacts — pick one to avoid a duplicate:'}
              </p>
              <ul className="mt-2 space-y-1">
                {data?.candidates.map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1"
                  >
                    <span className="text-sm font-medium text-neutral-800">{c.name}</span>
                    {c.email ? <span className="text-xs text-neutral-500">{c.email}</span> : null}
                    {c.phoneE164 ? (
                      <span className="text-xs text-neutral-500">{c.phoneE164}</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onResolved({ contactId: c.id, contactName: c.name })}
                      className="ml-auto text-xs font-medium text-primary-700 hover:underline"
                    >
                      Use →
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-neutral-500">
              No existing contact found — a new one will be created.
            </p>
          )}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={createAndContinue} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'New contact & continue →'}
        </Button>
        <span className="text-[11px] text-neutral-500">
          Or pick an existing match above to log against them.
        </span>
      </div>
    </section>
  )
}

const OUTCOME_LABEL: Record<string, string> = {
  answered: 'Answered',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
}

function RecentSummaries() {
  const [filter, setFilter] = useState<'all' | 'mine'>('all')
  const query = trpc.callSummaries.recent.useQuery({ filter, limit: 30 })
  const rows = query.data ?? []

  return (
    <section className="rounded-lg border border-neutral-200 bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-neutral-900">Recent call summaries</h2>
        <div className="flex items-center gap-1">
          {(['all', 'mine'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                filter === f
                  ? 'rounded-full bg-primary-600 px-2.5 py-0.5 text-xs font-medium text-white'
                  : 'rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200'
              }
            >
              {f === 'all' ? 'Everyone' : 'Mine'}
            </button>
          ))}
        </div>
      </div>
      {query.isLoading ? (
        <p className="p-4 text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-neutral-600">
          No call summaries yet — log one above and it&apos;ll appear here.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-neutral-900">
                  {r.contact ? (
                    <Link href={`/contacts/${r.contact.id}`} className="hover:underline">
                      {r.contact.name}
                    </Link>
                  ) : (
                    'Unlinked'
                  )}
                </span>
                {r.summary ? (
                  <span className="block truncate text-xs text-neutral-500">{r.summary}</span>
                ) : null}
              </span>
              {r.outcome ? (
                <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
                  {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                </span>
              ) : null}
              <span className="shrink-0 text-[11px] text-neutral-400">
                {r.authorName ? `${r.authorName} · ` : ''}
                {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
                  new Date(r.occurredAt),
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
