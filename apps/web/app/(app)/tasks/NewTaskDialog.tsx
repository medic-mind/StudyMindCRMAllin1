// Create-task dialog. CLAUDE.md §27, §3.
// Opens an inline form, calls task.create, refreshes the task list on success.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  /** Optional preset linkages from the parent page. */
  contactId?: string
  familyId?: string
  /** When the contact is preset (e.g. from a contact page), its display name. */
  contactName?: string
}

export function NewTaskDialog({ contactId, familyId, contactName }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Optional contact linkage. When a contactId is preset by the parent it is
  // locked; otherwise the agent may search and pick one.
  const presetContact = Boolean(contactId)
  const [contactQuery, setContactQuery] = useState('')
  const [pickedContactId, setPickedContactId] = useState<string | null>(contactId ?? null)
  const contactSearch = trpc.contact.list.useQuery(
    { q: contactQuery, limit: 8 },
    { enabled: open && !presetContact && contactQuery.trim().length >= 2 },
  )

  const usersQuery = trpc.task.assignableUsers.useQuery({}, { enabled: open })
  const create = trpc.task.create.useMutation({
    onSuccess: () => {
      setOpen(false)
      setTitle('')
      setDescription('')
      setAssigneeId('')
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

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        New task
      </Button>
    )
  }

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
      dueAt: dueAt ? new Date(dueAt) : undefined,
      contactId: pickedContactId ?? undefined,
      familyId,
    })
  }

  return (
    <div
      role="dialog"
      aria-label="Create task"
      className="rounded-md border border-neutral-200 bg-white p-4 shadow-card"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">New task</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>
      <form onSubmit={handleSubmit} className="mt-3 space-y-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-neutral-700">Title</span>
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={280}
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-neutral-700">Description (optional)</span>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-neutral-700">Assignee</span>
          <select
            required
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          >
            <option value="">Select an assignee…</option>
            {(usersQuery.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-neutral-700">Due (optional)</span>
          <input
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-neutral-700">Linked contact (optional)</span>
          {presetContact ? (
            <span className="rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-700">
              {contactName ?? 'This contact'}
            </span>
          ) : pickedContactId && contactQuery ? (
            <span className="flex items-center justify-between rounded border border-primary-200 bg-primary-50 px-2 py-1 text-xs text-primary-800">
              {contactQuery}
              <button
                type="button"
                onClick={() => {
                  setPickedContactId(null)
                  setContactQuery('')
                }}
                className="text-primary-700 hover:underline"
              >
                Clear
              </button>
            </span>
          ) : (
            <>
              <input
                value={contactQuery}
                onChange={(e) => {
                  setContactQuery(e.target.value)
                  setPickedContactId(null)
                }}
                placeholder="Search contacts (name, email, phone)"
                className="rounded border border-neutral-300 bg-white px-2 py-1"
              />
              {contactSearch.data && contactSearch.data.items.length > 0 ? (
                <ul className="max-h-32 overflow-auto rounded border border-neutral-200">
                  {contactSearch.data.items.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPickedContactId(c.id)
                          setContactQuery(c.displayName)
                        }}
                        className="block w-full px-2 py-1 text-left text-xs hover:bg-neutral-100"
                      >
                        {c.displayName}
                        {c.email ? <span className="text-neutral-500"> · {c.email}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create task'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
