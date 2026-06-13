// Quick-add contact — a workflow popup for the Contacts list header. Captures
// just the essentials (role, name, email, phone) so an agent can create a
// contact without leaving the list; the full multi-section form stays one
// click away at /contacts/new for when more detail is needed.
//
// Part of the move from full-page navigations to focused modal flows
// (CLAUDE.md §26 — client leaves, server trusts the tRPC procedure).

'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { MailIcon, XIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

type Kind = 'unclassified' | 'parent' | 'student' | 'tutor' | 'other'

function clean(s: string): string | undefined {
  const t = s.trim()
  return t.length > 0 ? t : undefined
}

export function QuickAddContactButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>New contact</Button>
      {open ? <QuickAddModal onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function QuickAddModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [kind, setKind] = useState<Kind>('unclassified')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  const create = trpc.contact.create.useMutation()

  async function submit(thenOpen: boolean) {
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
      toast.success('Contact created')
      await utils.contact.list.invalidate()
      if (thenOpen) router.push(`/contacts/${id}`)
      else router.refresh()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create contact')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New contact"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-neutral-900">New contact</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role" htmlFor="qa-kind">
              <Select id="qa-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="unclassified">Unclassified</option>
                <option value="parent">Parent</option>
                <option value="student">Student</option>
                <option value="tutor">Tutor</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <div />
            <Field label="First name" htmlFor="qa-first">
              <Input id="qa-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoFocus />
            </Field>
            <Field label="Last name" htmlFor="qa-last">
              <Input id="qa-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
            <Field label="Email" htmlFor="qa-email" className="col-span-2">
              <span className="relative block">
                <MailIcon size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
                <Input
                  id="qa-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-7"
                  placeholder="name@example.com"
                />
              </span>
            </Field>
            <Field label="Phone" htmlFor="qa-phone" className="col-span-2">
              <PhoneInput id="qa-phone" value={phone} onChange={setPhone} />
            </Field>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-neutral-200 px-4 py-2.5">
          <Link
            href="/contacts/new"
            className="text-xs font-medium text-neutral-500 hover:text-primary-700 hover:underline"
          >
            Need more fields? Full form →
          </Link>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={create.isPending} onClick={() => submit(false)}>
              Save
            </Button>
            <Button type="button" size="sm" disabled={create.isPending} onClick={() => submit(true)}>
              {create.isPending ? 'Creating…' : 'Save & open'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
