// Log-complaint modal for the Complaints hub: pick the customer (typeahead),
// then the same fields as the contact page's ComplaintsSection form — title,
// details, severity, and category (preset + free-type). Server work is the
// existing complaint.create (audited; the complaint is stored on the
// customer's record). Esc closes, backdrop closes, focus restore.
// CLAUDE.md §26, §28.

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SuggestInput } from '@/components/ui/suggest-input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'
import { XIcon } from '@/components/ui/icon'

type Severity = 'low' | 'medium' | 'high'

export function NewComplaintDialog() {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [category, setCategory] = useState('')
  const [errors, setErrors] = useState<{
    customer?: string
    title?: string
    form?: string
  }>({})
  const titleRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const [contactQuery, setContactQuery] = useState('')
  const [pickedContactId, setPickedContactId] = useState<string | null>(null)
  const contactSearch = trpc.contact.list.useQuery(
    { q: contactQuery, limit: 8 },
    { enabled: open && contactQuery.trim().length >= 2 && !pickedContactId },
  )
  const categoriesQuery = trpc.complaint.categories.useQuery(undefined, { enabled: open })

  const create = trpc.complaint.create.useMutation({
    onSuccess: async () => {
      setOpen(false)
      setTitle('')
      setDescription('')
      setSeverity('medium')
      setCategory('')
      setContactQuery('')
      setPickedContactId(null)
      setErrors({})
      toast.success('Complaint logged')
      await utils.complaint.activeCount.invalidate()
      router.refresh()
    },
    onError: (e) => {
      setErrors({ form: e.message })
      toast.error(e.message ?? 'Could not log the complaint')
    },
  })

  // Esc closes; focus the customer search on open; restore focus on close.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (!open) triggerRef.current?.focus()
  }, [open])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const next: { customer?: string; title?: string } = {}
    if (!pickedContactId) next.customer = 'Pick the customer the complaint is about.'
    if (title.trim().length < 2) next.title = 'Give the complaint a short title.'
    if (next.customer || next.title || !pickedContactId) {
      setErrors(next)
      if (next.title && !next.customer) titleRef.current?.focus()
      return
    }
    setErrors({})
    create.mutate({
      contactId: pickedContactId,
      title: title.trim(),
      description: description.trim() || undefined,
      severity,
      category: category.trim() || undefined,
    })
  }

  return (
    <>
      <Button type="button" size="sm" ref={triggerRef} onClick={() => setOpen(true)}>
        Log complaint
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
            aria-label="Log complaint"
            className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
              <h3 className="text-base font-semibold text-neutral-900">Log complaint</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
              >
                <XIcon size={14} />
              </button>
            </header>
            <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
              <Field label="Customer" required error={errors.customer}>
                {pickedContactId ? (
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
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Input
                      value={contactQuery}
                      onChange={(e) => setContactQuery(e.target.value)}
                      placeholder="Search customers by name, email, or phone…"
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
                                if (errors.customer) setErrors((p) => ({ ...p, customer: undefined }))
                                setTimeout(() => titleRef.current?.focus(), 0)
                              }}
                              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-primary-50 hover:text-primary-800"
                            >
                              <span className="font-medium">{c.displayName}</span>
                              {c.email && (
                                <span className="ml-2 text-xs text-neutral-500">{c.email}</span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
              </Field>

              <Field label="Title" required error={errors.title}>
                <Input
                  ref={titleRef}
                  required
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value)
                    if (errors.title) setErrors((p) => ({ ...p, title: undefined }))
                  }}
                  maxLength={200}
                  placeholder="What is the complaint? (short title)"
                />
              </Field>

              <Field label="Details (optional)">
                <Textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={4000}
                  placeholder="What happened, what the customer is unhappy about…"
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Severity">
                  <Select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as Severity)}
                  >
                    <option value="low">Low severity</option>
                    <option value="medium">Medium severity</option>
                    <option value="high">High severity</option>
                  </Select>
                </Field>
                <Field label="Category (optional)">
                  <SuggestInput
                    aria-label="Complaint category"
                    placeholder="Pick or type new"
                    options={categoriesQuery.data ?? []}
                    value={category}
                    onChange={setCategory}
                  />
                </Field>
              </div>

              {errors.form && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {errors.form}
                </p>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-100 pt-3">
                <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={create.isPending}>
                  {create.isPending ? 'Logging…' : 'Log complaint'}
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
  error,
  children,
}: {
  label: string
  required?: boolean
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p role="alert" className="mt-1 text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
