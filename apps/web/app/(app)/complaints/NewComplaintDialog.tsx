// Log-complaint modal for the Complaints hub. Find the customer with the shared
// ContactFinder (search the CRM, or add a brand-new person inline with a de-dup
// guard) then the same fields as the contact page's ComplaintsSection form —
// title, details, severity, and category (preset + free-type). Server work is
// the existing complaint.create (audited; the complaint is stored on the
// customer's record AND announced to #complaintcallsummaries — the reply echoes
// that Slack status). Esc closes, backdrop closes, focus restore.
// CLAUDE.md §26, §28.

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { ContactFinder, type ResolvedContact } from '@/components/contact/contact-finder'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SuggestInput } from '@/components/ui/suggest-input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'
import { XIcon } from '@/components/ui/icon'

type Severity = 'low' | 'medium' | 'high'

/** Turn the best-effort Slack result into a plain-English toast line. */
function slackNote(status: string | undefined): string {
  if (status === 'skipped') return 'Slack not configured — set it up in Settings → Slack channels'
  return "couldn't post to Slack (recorded on the CRM)"
}

export function NewComplaintDialog() {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<ResolvedContact | null>(null)
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

  const categoriesQuery = trpc.complaint.categories.useQuery(undefined, { enabled: open })

  function reset() {
    setPicked(null)
    setTitle('')
    setDescription('')
    setSeverity('medium')
    setCategory('')
    setErrors({})
  }

  const create = trpc.complaint.create.useMutation({
    onSuccess: async (data) => {
      setOpen(false)
      reset()
      const status = data.slack?.status
      if (status === 'sent') {
        toast.success('Complaint logged and posted to #complaintcallsummaries')
      } else {
        toast.success(`Complaint logged — ${slackNote(status)}`)
      }
      await utils.complaint.activeCount.invalidate()
      router.refresh()
    },
    onError: (e) => {
      setErrors({ form: e.message })
      toast.error(e.message ?? 'Could not log the complaint')
    },
  })

  // Esc closes; restore focus to the trigger on close.
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
    if (!picked) next.customer = 'Find the customer, or add them if they are new.'
    if (title.trim().length < 2) next.title = 'Give the complaint a short title.'
    if (next.customer || next.title || !picked) {
      setErrors(next)
      if (next.title && !next.customer) titleRef.current?.focus()
      return
    }
    setErrors({})
    create.mutate({
      contactId: picked.contactId,
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
                {picked ? (
                  <div className="flex items-center justify-between rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-800">
                    <span className="truncate">{picked.contactName}</span>
                    <button
                      type="button"
                      onClick={() => setPicked(null)}
                      className="ml-2 shrink-0 text-xs text-primary-700 hover:underline"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <ContactFinder
                    createCta="Add & continue →"
                    searchPlaceholder="Search customers by name, email, or phone…"
                    onResolved={(r) => {
                      setPicked(r)
                      if (errors.customer) setErrors((p) => ({ ...p, customer: undefined }))
                      setTimeout(() => titleRef.current?.focus(), 0)
                    }}
                  />
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
