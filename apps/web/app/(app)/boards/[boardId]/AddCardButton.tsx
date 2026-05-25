// Add-card dialog. ADR 0018. Lets an agent create a card either with a new
// contact (name/email/phone/role) or by linking an existing contact, choose
// a subject (pick existing or create new), attach labels, and pick the
// target stage. Sales Executive and above (server also gates card.create).

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

interface StageOption {
  id: string
  name: string
}
interface LabelOption {
  id: string
  name: string
  color: string
}

interface Props {
  boardId: string
  stages: ReadonlyArray<StageOption>
  labels: ReadonlyArray<LabelOption>
}

type Mode = 'new' | 'existing'
type ContactRole = 'parent' | 'student' | 'tutor' | 'la_caseworker' | 'other'

export function AddCardButton({ boardId, stages, labels }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('new')

  // New-contact fields.
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [kind, setKind] = useState<ContactRole>('parent')

  // Existing-contact search.
  const [contactQuery, setContactQuery] = useState('')
  const [contactId, setContactId] = useState<string | null>(null)
  const contactSearch = trpc.contact.list.useQuery(
    { q: contactQuery, limit: 8 },
    { enabled: mode === 'existing' && contactQuery.trim().length >= 2 },
  )

  // Subject picker.
  const [subjectQuery, setSubjectQuery] = useState('')
  const [subjectId, setSubjectId] = useState<string | null>(null)
  const subjectSearch = trpc.subject.list.useQuery(
    { q: subjectQuery || undefined },
    { enabled: open },
  )
  const findOrCreateSubject = trpc.subject.findOrCreate.useMutation()

  const [labelIds, setLabelIds] = useState<string[]>([])
  const [stageId, setStageId] = useState<string>(stages[0]?.id ?? '')

  const utils = trpc.useUtils()
  const create = trpc.card.create.useMutation({
    onSuccess: () => {
      toast.success('Card created')
      reset()
      setOpen(false)
      void utils.card.list.invalidate({ boardId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not create card'),
  })

  function reset() {
    setMode('new')
    setFirstName('')
    setLastName('')
    setEmail('')
    setPhone('')
    setKind('parent')
    setContactQuery('')
    setContactId(null)
    setSubjectQuery('')
    setSubjectId(null)
    setLabelIds([])
    setStageId(stages[0]?.id ?? '')
  }

  async function resolveSubjectId(): Promise<string | undefined> {
    if (subjectId) return subjectId
    const typed = subjectQuery.trim()
    if (!typed) return undefined
    const created = await findOrCreateSubject.mutateAsync({ name: typed })
    return created.id
  }

  async function submit() {
    if (!stageId) {
      toast.error('Pick a target stage')
      return
    }
    let contact:
      | { contactId: string }
      | { contact: { kind: ContactRole; firstName?: string; lastName?: string; email?: string; phoneE164?: string } }
    if (mode === 'existing') {
      if (!contactId) {
        toast.error('Pick an existing contact')
        return
      }
      contact = { contactId }
    } else {
      if (!firstName.trim() && !lastName.trim() && !email.trim()) {
        toast.error('Enter at least a name or email for the new contact')
        return
      }
      contact = {
        contact: {
          kind,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          email: email.trim() || undefined,
          phoneE164: phone.trim() || undefined,
        },
      }
    }

    let resolvedSubjectId: string | undefined
    try {
      resolvedSubjectId = await resolveSubjectId()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not resolve subject')
      return
    }

    create.mutate({
      boardId,
      stageId,
      contact,
      subjectId: resolvedSubjectId,
      labelIds: labelIds.length > 0 ? labelIds : undefined,
    })
  }

  return (
    <div className="relative inline-block text-left">
      <Button size="sm" onClick={() => setOpen((o) => !o)}>
        Add card
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Add card"
          className="absolute right-0 z-20 mt-2 w-96 rounded-lg border border-neutral-200 bg-white p-4 text-left shadow-lg"
        >
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('new')}
                className={`flex-1 rounded border px-2 py-1 text-xs font-medium ${
                  mode === 'new'
                    ? 'border-primary-300 bg-primary-50 text-primary-800'
                    : 'border-neutral-300 text-neutral-700'
                }`}
              >
                New contact
              </button>
              <button
                type="button"
                onClick={() => setMode('existing')}
                className={`flex-1 rounded border px-2 py-1 text-xs font-medium ${
                  mode === 'existing'
                    ? 'border-primary-300 bg-primary-50 text-primary-800'
                    : 'border-neutral-300 text-neutral-700'
                }`}
              >
                Link existing
              </button>
            </div>

            {mode === 'new' ? (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Input
                    placeholder="First name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                  <Input
                    placeholder="Last name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
                <Input
                  placeholder="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Input
                  placeholder="Phone (+447…)"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <Select value={kind} onChange={(e) => setKind(e.target.value as ContactRole)}>
                  <option value="parent">Parent</option>
                  <option value="student">Student</option>
                  <option value="tutor">Tutor</option>
                  <option value="la_caseworker">LA caseworker</option>
                  <option value="other">Other</option>
                </Select>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <Input
                  placeholder="Search contacts (name, email, phone)"
                  value={contactQuery}
                  onChange={(e) => {
                    setContactQuery(e.target.value)
                    setContactId(null)
                  }}
                />
                {contactSearch.data && contactSearch.data.items.length > 0 ? (
                  <ul className="max-h-32 overflow-auto rounded border border-neutral-200">
                    {contactSearch.data.items.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setContactId(c.id)
                            setContactQuery(c.displayName)
                          }}
                          className={`block w-full px-2 py-1 text-left text-xs hover:bg-neutral-100 ${
                            contactId === c.id ? 'bg-primary-50 text-primary-800' : ''
                          }`}
                        >
                          {c.displayName}
                          {c.email ? <span className="text-neutral-500"> · {c.email}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-neutral-700">Subject</span>
              <Input
                placeholder="Type to search or create"
                value={subjectQuery}
                onChange={(e) => {
                  setSubjectQuery(e.target.value)
                  setSubjectId(null)
                }}
              />
              {subjectSearch.data && subjectSearch.data.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {subjectSearch.data.slice(0, 8).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setSubjectId(s.id)
                        setSubjectQuery(s.name)
                      }}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        subjectId === s.id
                          ? 'border-primary-300 bg-primary-50 text-primary-800'
                          : 'border-neutral-300 text-neutral-700'
                      }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </label>

            {labels.length > 0 ? (
              <div>
                <span className="mb-1 block text-xs font-medium text-neutral-700">Labels</span>
                <div className="flex flex-wrap gap-1">
                  {labels.map((l) => {
                    const on = labelIds.includes(l.id)
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() =>
                          setLabelIds((prev) =>
                            on ? prev.filter((x) => x !== l.id) : [...prev, l.id],
                          )
                        }
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          on ? 'text-white' : 'text-neutral-700'
                        }`}
                        style={on ? { backgroundColor: '#3b82f6', borderColor: '#3b82f6' } : undefined}
                      >
                        {l.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-neutral-700">Stage</span>
              <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={create.isPending || findOrCreateSubject.isPending}
                onClick={() => void submit()}
              >
                {create.isPending ? 'Creating…' : 'Create card'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
