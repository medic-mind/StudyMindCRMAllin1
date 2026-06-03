// Add-card dialog. ADR 0018. Lets an agent create a card either with a new
// contact (name/email/phone/role) or by linking an existing contact, choose a
// subject, attach labels, write an optional note, and pick the target stage.
//
// Rendered two ways (CLAUDE.md §26):
//   - `toolbar`  — the primary "Add card" button in the board toolbar.
//   - `column`   — a quiet "+ Add a card" footer inside each column, pre-aimed
//     at that column's stage so an agent picks exactly where the card lands.
//
// On success the new card is inserted optimistically via `onCreated` so it
// appears the instant the dialog closes, then reconciled by the board's
// router.refresh. Sales Executive and above (server also gates card.create).

'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { PlusIcon, XIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
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

/** Shape inserted optimistically into the board — matches BoardDnd's CardData. */
export interface CreatedCard {
  id: string
  stageId: string
  contactId: string
  contactName: string
  contactEmail?: string | null
  contactPhone?: string | null
  description?: string | null
  subject: { id: string; name: string } | null
  labels: ReadonlyArray<LabelOption>
  lastActivityAt: string | Date | null
  dueAt?: Date | string | null
  scheduledCallAt?: Date | string | null
  priority?: number | null
  assigneeId?: string | null
  assigneeName?: string | null
  assigneeEmail?: string | null
}

interface Props {
  boardId: string
  stages: ReadonlyArray<StageOption>
  labels: ReadonlyArray<LabelOption>
  /** Pre-selected target stage (per-column add). Defaults to the first stage. */
  defaultStageId?: string
  /** Optimistic insert callback so the new card shows instantly. */
  onCreated?: (card: CreatedCard) => void
  /** `toolbar` = primary button; `column` = quiet footer row inside a column. */
  variant?: 'toolbar' | 'column'
}

type Mode = 'new' | 'existing'
type ContactRole = 'parent' | 'student' | 'tutor' | 'other'

export function AddCardButton({
  boardId,
  stages,
  labels,
  defaultStageId,
  onCreated,
  variant = 'toolbar',
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
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
  const [existing, setExisting] = useState<{ name: string; email: string | null } | null>(null)
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
  const [description, setDescription] = useState('')
  const [stageId, setStageId] = useState<string>(defaultStageId ?? stages[0]?.id ?? '')

  // Display fields captured at submit time, merged with the server id in
  // onSuccess to build the optimistic card (avoids reading state mid-reset).
  const pending = useRef<Omit<CreatedCard, 'id' | 'stageId' | 'contactId'> | null>(null)

  const utils = trpc.useUtils()
  const create = trpc.card.create.useMutation({
    onSuccess: (data) => {
      if (pending.current) {
        onCreated?.({
          ...pending.current,
          id: data.id,
          stageId: data.stageId,
          contactId: data.contactId,
        })
      }
      pending.current = null
      toast.success('Card created')
      reset()
      setOpen(false)
      void utils.card.list.invalidate({ boardId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not create card'),
  })

  // Close on Escape while the dialog is open.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  function openDialog() {
    setStageId(defaultStageId ?? stages[0]?.id ?? '')
    setOpen(true)
  }

  function reset() {
    setMode('new')
    setFirstName('')
    setLastName('')
    setEmail('')
    setPhone('')
    setKind('parent')
    setContactQuery('')
    setContactId(null)
    setExisting(null)
    setSubjectQuery('')
    setSubjectId(null)
    setLabelIds([])
    setDescription('')
    setStageId(defaultStageId ?? stages[0]?.id ?? '')
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
      | {
          contact: {
            kind: ContactRole
            firstName?: string
            lastName?: string
            email?: string
            phoneE164?: string
          }
        }
    let displayName: string
    let displayEmail: string | null
    let displayPhone: string | null
    if (mode === 'existing') {
      if (!contactId) {
        toast.error('Pick an existing contact')
        return
      }
      contact = { contactId }
      displayName = existing?.name || contactQuery.trim() || 'Contact'
      displayEmail = existing?.email ?? null
      displayPhone = null
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
      displayName = `${firstName.trim()} ${lastName.trim()}`.trim() || email.trim() || 'New contact'
      displayEmail = email.trim() || null
      displayPhone = phone.trim() || null
    }

    let resolvedSubjectId: string | undefined
    try {
      resolvedSubjectId = await resolveSubjectId()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not resolve subject')
      return
    }

    pending.current = {
      contactName: displayName,
      contactEmail: displayEmail,
      contactPhone: displayPhone,
      description: description.trim() || null,
      subject: resolvedSubjectId
        ? { id: resolvedSubjectId, name: subjectQuery.trim() || 'Subject' }
        : null,
      labels: labels.filter((l) => labelIds.includes(l.id)),
      lastActivityAt: null,
      dueAt: null,
      scheduledCallAt: null,
      priority: null,
      assigneeId: null,
      assigneeName: null,
      assigneeEmail: null,
    }

    create.mutate({
      boardId,
      stageId,
      contact,
      subjectId: resolvedSubjectId,
      labelIds: labelIds.length > 0 ? labelIds : undefined,
      description: description.trim() || undefined,
    })
  }

  const targetStageName = stages.find((s) => s.id === stageId)?.name

  const trigger =
    variant === 'column' ? (
      <button
        type="button"
        onClick={openDialog}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-300 px-2 py-2 text-xs font-medium text-neutral-500 transition-colors hover:border-primary-300 hover:bg-primary-50/60 hover:text-primary-700"
      >
        <PlusIcon size={14} />
        Add a card
      </button>
    ) : (
      <Button size="sm" onClick={openDialog}>
        <PlusIcon size={15} className="-ml-0.5 mr-1" />
        Add card
      </Button>
    )

  return (
    <>
      {trigger}
      {open && mounted
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-4 backdrop-blur-sm sm:items-center"
              role="dialog"
              aria-modal="true"
              aria-label="Add a card"
              onClick={() => setOpen(false)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="relative my-8 w-full max-w-md rounded-xl border border-neutral-200 bg-white shadow-xl"
              >
                <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3">
                  <h2 className="text-sm font-semibold text-neutral-900">
                    Add a card
                    {targetStageName ? (
                      <span className="ml-1.5 font-normal text-neutral-500">
                        to {targetStageName}
                      </span>
                    ) : null}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                    className="rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                  >
                    <XIcon size={16} />
                  </button>
                </div>

                <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4 text-sm">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setMode('new')}
                      className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                        mode === 'new'
                          ? 'border-primary-300 bg-primary-50 text-primary-800'
                          : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'
                      }`}
                    >
                      New contact
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('existing')}
                      className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                        mode === 'existing'
                          ? 'border-primary-300 bg-primary-50 text-primary-800'
                          : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'
                      }`}
                    >
                      Link existing
                    </button>
                  </div>

                  {mode === 'new' ? (
                    <div className="flex flex-col gap-3">
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
                          setExisting(null)
                        }}
                      />
                      {contactSearch.data && contactSearch.data.items.length > 0 ? (
                        <ul className="max-h-40 overflow-auto rounded-md border border-neutral-200">
                          {contactSearch.data.items.map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setContactId(c.id)
                                  setContactQuery(c.displayName)
                                  setExisting({ name: c.displayName, email: c.email ?? null })
                                }}
                                className={`block w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-neutral-100 ${
                                  contactId === c.id ? 'bg-primary-50 text-primary-800' : ''
                                }`}
                              >
                                {c.displayName}
                                {c.email ? (
                                  <span className="text-neutral-500"> · {c.email}</span>
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  )}

                  <Field label="Subject" hint="Search an existing subject or type a new one">
                    <Input
                      placeholder="e.g. UCAT, A-level Maths"
                      value={subjectQuery}
                      onChange={(e) => {
                        setSubjectQuery(e.target.value)
                        setSubjectId(null)
                      }}
                    />
                    {subjectSearch.data && subjectSearch.data.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {subjectSearch.data.slice(0, 8).map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                              setSubjectId(s.id)
                              setSubjectQuery(s.name)
                            }}
                            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                              subjectId === s.id
                                ? 'border-primary-300 bg-primary-50 text-primary-800'
                                : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'
                            }`}
                          >
                            {s.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </Field>

                  {labels.length > 0 ? (
                    <Field label="Labels">
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
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                                on ? 'border-transparent text-white' : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'
                              }`}
                              style={on ? { backgroundColor: '#3b82f6' } : undefined}
                            >
                              {l.name}
                            </button>
                          )
                        })}
                      </div>
                    </Field>
                  ) : null}

                  <Field label="Note" hint="Shown as the card's description preview">
                    <Textarea
                      placeholder="Anything the team should see at a glance…"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={3}
                    />
                  </Field>

                  <Field label="Stage">
                    <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>

                <div className="flex justify-end gap-2 border-t border-neutral-100 bg-neutral-50/60 px-5 py-3">
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
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
