// Log-complaint modal. Pick the customer from the CRM (ContactFinder) OR type
// them in manually (name + phone) when they're not in the CRM — either way the
// complaint is stored properly and, on save, ALWAYS posted to Slack
// #complaintcallsummaries via the connected bot (clearly flagged in the form),
// which starts the thread you then work on the complaint's page. Esc/backdrop
// close, focus restore. CLAUDE.md §26, §28.

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { ContactFinder, type ResolvedContact } from '@/components/contact/contact-finder'
import { Button } from '@/components/ui/button'
import { HashIcon, XIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select } from '@/components/ui/select'
import { SuggestInput } from '@/components/ui/suggest-input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Severity = 'low' | 'medium' | 'high'
type Mode = 'crm' | 'manual'

/** Plain-English Slack outcome for the success toast — reports the REAL channel
 *  it landed in (never a hardcoded guess) plus any actionable failure reason. */
function slackNote(slack: { status?: string; channelName?: string | null; detail?: string | null }): string {
  const channel = slack.channelName ?? 'Slack'
  if (slack.status === 'sent') return `posted to ${channel}`
  if (slack.status === 'skipped')
    return slack.detail ?? 'Slack not configured — set it up in Settings → Slack channels'
  return `couldn't post to Slack${slack.detail ? ` — ${slack.detail}` : ''} (still saved on the CRM)`
}

export function NewComplaintDialog() {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('crm')
  const [picked, setPicked] = useState<ResolvedContact | null>(null)
  const [manual, setManual] = useState({ name: '', phone: '', email: '' })
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [category, setCategory] = useState('')
  const [errors, setErrors] = useState<{ customer?: string; title?: string; form?: string }>({})
  const titleRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const categoriesQuery = trpc.complaint.categories.useQuery(undefined, { enabled: open })

  function reset() {
    setMode('crm')
    setPicked(null)
    setManual({ name: '', phone: '', email: '' })
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
      const slack = data.slack ?? {}
      if (slack.status === 'sent') {
        toast.success(`Complaint logged and ${slackNote(slack)}`)
      } else {
        // Not posted where the operator expects — surface it clearly, not as a
        // silent success, so a misroute / uninvited bot is obvious.
        toast.warning(`Complaint logged — ${slackNote(slack)}`)
      }
      await utils.complaint.activeCount.invalidate()
      await utils.complaint.list.invalidate()
      router.push(`/complaints/${data.id}`)
    },
    onError: (e) => {
      setErrors({ form: e.message })
      toast.error(e.message ?? 'Could not log the complaint')
    },
  })

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

  const hasCustomer = mode === 'crm' ? Boolean(picked) : manual.name.trim().length >= 2

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const next: { customer?: string; title?: string } = {}
    if (!hasCustomer)
      next.customer =
        mode === 'crm'
          ? 'Find the customer, or switch to "Enter manually".'
          : 'Enter the customer’s name (2+ characters).'
    if (title.trim().length < 2) next.title = 'Give the complaint a short title.'
    if (next.customer || next.title) {
      setErrors(next)
      if (next.title && !next.customer) titleRef.current?.focus()
      return
    }
    setErrors({})
    create.mutate({
      ...(mode === 'crm' && picked
        ? { contactId: picked.contactId }
        : {
            person: {
              name: manual.name.trim(),
              phone: manual.phone.trim() || undefined,
              email: manual.email.trim() || undefined,
            },
          }),
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
              {/* Slack notice — always sent, made explicit. */}
              <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <HashIcon size={14} className="mt-0.5 shrink-0" />
                <span>
                  Logging this <strong>posts it to Slack #complaintcallsummaries</strong> and starts
                  a thread — every message you add here is mirrored to that thread and the
                  customer’s CRM record.
                </span>
              </div>

              <Field label="Customer" required error={errors.customer}>
                <div className="mb-2 inline-flex rounded-md border border-neutral-200 bg-neutral-50 p-0.5 text-xs">
                  {(['crm', 'manual'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setMode(m)
                        setErrors((p) => ({ ...p, customer: undefined }))
                      }}
                      className={
                        mode === m
                          ? 'rounded px-2.5 py-1 font-medium text-primary-800 bg-white shadow-sm'
                          : 'rounded px-2.5 py-1 text-neutral-600 hover:text-neutral-900'
                      }
                    >
                      {m === 'crm' ? 'Find in CRM' : 'Enter manually'}
                    </button>
                  ))}
                </div>

                {mode === 'crm' ? (
                  picked ? (
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
                  )
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Input
                      value={manual.name}
                      onChange={(e) => {
                        setManual((m) => ({ ...m, name: e.target.value }))
                        if (errors.customer) setErrors((p) => ({ ...p, customer: undefined }))
                      }}
                      placeholder="Full name"
                      aria-label="Customer name"
                    />
                    <PhoneInput
                      value={manual.phone}
                      onChange={(v) => setManual((m) => ({ ...m, phone: v }))}
                    />
                    <Input
                      value={manual.email}
                      onChange={(e) => setManual((m) => ({ ...m, email: e.target.value }))}
                      placeholder="Email (optional)"
                      type="email"
                      className="sm:col-span-2"
                      aria-label="Customer email"
                    />
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
                  <Select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
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
                  {create.isPending ? 'Logging…' : 'Log complaint & post to Slack'}
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
