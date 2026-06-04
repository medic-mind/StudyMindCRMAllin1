// Create-task modal. Opens a proper centered dialog over a backdrop —
// not an inline panel that hijacks the page. Esc closes, click outside
// closes, focus returns to the trigger. CLAUDE.md §27 (server gates),
// §28 (focus trap + skip-link compatible).

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

interface Props {
  /** Optional preset linkages from the parent page. */
  contactId?: string
  familyId?: string
  /** When the contact is preset (e.g. from a contact page), its display name. */
  contactName?: string
  /** Customise the trigger so the dialog can be a compact row action. */
  triggerLabel?: React.ReactNode
  triggerVariant?: 'default' | 'secondary' | 'ghost' | 'destructive'
  triggerSize?: 'xs' | 'sm' | 'md' | 'lg'
  triggerClassName?: string
}

export function NewTaskDialog({
  contactId,
  familyId,
  contactName,
  triggerLabel,
  triggerVariant,
  triggerSize = 'sm',
  triggerClassName,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const presetContact = Boolean(contactId)
  const [contactQuery, setContactQuery] = useState('')
  const [pickedContactId, setPickedContactId] = useState<string | null>(contactId ?? null)
  const contactSearch = trpc.contact.list.useQuery(
    { q: contactQuery, limit: 8 },
    { enabled: open && !presetContact && contactQuery.trim().length >= 2 },
  )

  const usersQuery = trpc.task.assignableUsers.useQuery({}, { enabled: open })
  const teamsQuery = trpc.team.pickList.useQuery(undefined, { enabled: open })
  const create = trpc.task.create.useMutation({
    onSuccess: () => {
      setOpen(false)
      setTitle('')
      setDescription('')
      setAssigneeId('')
      setTeamId('')
      setDueAt('')
      setContactQuery('')
      setPickedContactId(contactId ?? null)
      setError(null)
      toast.success('Task created')
      router.refresh()
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not create task')
    },
  })

  // Esc closes; focus title on open; restore focus on close.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    // Schedule focus on next tick so the input is mounted.
    const t = setTimeout(() => titleRef.current?.focus(), 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      // Restore focus to the trigger when the modal closes.
      triggerRef.current?.focus()
    }
  }, [open])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (title.trim().length === 0 || assigneeId.trim().length === 0) {
      setError('Title and assignee are required.')
      return
    }
    create.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      assigneeId,
      teamId: teamId || undefined,
      dueAt: dueAt ? new Date(dueAt) : undefined,
      contactId: pickedContactId ?? undefined,
      familyId,
    })
  }

  return (
    <>
      <Button
        type="button"
        size={triggerSize}
        variant={triggerVariant}
        className={triggerClassName}
        ref={triggerRef}
        onClick={() => setOpen(true)}
      >
        {triggerLabel ?? 'New task'}
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-4 sm:p-8"
          onClick={() => setOpen(false)}
          aria-hidden
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Create task"
            className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
              <h3 className="text-base font-semibold text-neutral-900">New task</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
              >
                ✕
              </button>
            </header>
            <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
              <Field label="Title" required>
                <Input
                  ref={titleRef}
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={280}
                  placeholder="What needs doing?"
                />
              </Field>

              <Field label="Description (optional)">
                <Textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={4000}
                  placeholder="Add any context the assignee will need."
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Assignee" required>
                  <Select
                    required
                    value={assigneeId}
                    onChange={(e) => setAssigneeId(e.target.value)}
                  >
                    <option value="">Select an assignee…</option>
                    {(usersQuery.data ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name ? `${u.name} (${u.email})` : u.email}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Team (optional)">
                  <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                    <option value="">— None —</option>
                    {(teamsQuery.data ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Due (optional)">
                  <Input
                    type="date"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Linked contact (optional)">
                {presetContact ? (
                  <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                    {contactName ?? 'This contact'}
                  </p>
                ) : pickedContactId && contactQuery ? (
                  <div className="flex items-center justify-between rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-800">
                    <span className="truncate">{contactQuery}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setPickedContactId(null)
                        setContactQuery('')
                      }}
                      className="ml-2 shrink-0 text-xs text-primary-700 hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Input
                      value={contactQuery}
                      onChange={(e) => {
                        setContactQuery(e.target.value)
                        setPickedContactId(null)
                      }}
                      placeholder="Search contacts by name, email, or phone…"
                    />
                    {contactSearch.data && contactSearch.data.items.length > 0 ? (
                      <ul className="max-h-40 overflow-auto rounded-md border border-neutral-200 bg-white shadow-sm">
                        {contactSearch.data.items.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setPickedContactId(c.id)
                                setContactQuery(c.displayName)
                              }}
                              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-primary-50 hover:text-primary-800"
                            >
                              <span className="font-medium">{c.displayName}</span>
                              {c.email && (
                                <span className="ml-2 text-xs text-neutral-500">
                                  {c.email}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
              </Field>

              {error && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-100 pt-3">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={create.isPending}>
                  {create.isPending ? 'Creating…' : 'Create task'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
