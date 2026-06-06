// Compose modal for emailing an invoice or a payment reminder from the CRM.
//
// The platform's own email template is fetched (invoicing.invoices.emailPreview)
// and prefilled so staff never retype — and the format matches the B2B site
// exactly: any field the user does NOT edit is omitted from the request, so the
// platform sends its template verbatim. Edited fields are sent as overrides.
// Both attach the same PDF the preview shows (ADR 0036).

'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

export type ComposeMode = 'send' | 'reminder'

interface EmailTemplate {
  to: string
  cc: string
  subject: string
  body: string
  fromEmail: string
  fromName: string
}

const EMPTY: EmailTemplate = { to: '', cc: '', subject: '', body: '', fromEmail: '', fromName: '' }

export function InvoiceComposeModal({
  mode,
  invoicingId,
  invoiceNumber,
  onClose,
  onSent,
}: {
  mode: ComposeMode | null
  invoicingId: string | null
  invoiceNumber?: string | null
  onClose: () => void
  onSent: () => void
}) {
  const send = trpc.invoicing.invoices.send.useMutation()
  const reminder = trpc.invoicing.invoices.sendReminder.useMutation()

  const open = mode !== null && invoicingId !== null
  const isReminder = mode === 'reminder'
  const pending = send.isPending || reminder.isPending

  // Pull the platform's rendered template for this invoice + kind.
  const preview = trpc.invoicing.invoices.emailPreview.useQuery(
    { invoicingId: invoicingId ?? '', kind: (mode ?? 'send') as ComposeMode },
    { enabled: open, retry: false, staleTime: 60_000 },
  )

  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [attachPdf, setAttachPdf] = useState(true)
  const [template, setTemplate] = useState<EmailTemplate>(EMPTY)
  const [applied, setApplied] = useState(false)

  // Reset whenever the target (invoice or kind) changes.
  useEffect(() => {
    setTo('')
    setCc('')
    setSubject('')
    setBody('')
    setFromEmail('')
    setFromName('')
    setAttachPdf(true)
    setTemplate(EMPTY)
    setApplied(false)
  }, [mode, invoicingId])

  // Prefill from the platform template once it resolves for this open session.
  useEffect(() => {
    if (!open || applied) return
    const d = preview.data
    if (!d) return
    const t: EmailTemplate = {
      to: d.to ?? '',
      cc: d.cc ?? '',
      subject: d.subject ?? '',
      body: d.body ?? '',
      fromEmail: d.fromEmail ?? '',
      fromName: d.fromName ?? '',
    }
    setTo(t.to)
    setCc(t.cc)
    setSubject(t.subject)
    setBody(t.body)
    setFromEmail(t.fromEmail)
    setFromName(t.fromName)
    setTemplate(t)
    setApplied(true)
  }, [open, applied, preview.data])

  function close() {
    onClose()
  }

  /** Include a field only when the user actually edited it (non-empty and
   *  different from the prefilled template) — so an unchanged send goes out as
   *  the platform's exact template. */
  function override(current: string, key: keyof EmailTemplate): string | undefined {
    const v = current.trim()
    return v && v !== template[key].trim() ? v : undefined
  }

  function compact<T extends Record<string, unknown>>(obj: T): T {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
  }

  async function submit() {
    if (!invoicingId) return
    try {
      if (isReminder) {
        const res = await reminder.mutateAsync(
          compact({
            invoicingId,
            to: override(to, 'to'),
            cc: override(cc, 'cc'),
            subject: override(subject, 'subject'),
            body: override(body, 'body'),
            attachPdf,
          }),
        )
        toast.success(`Reminder sent to ${res.to}`)
      } else {
        const res = await send.mutateAsync(
          compact({
            invoicingId,
            to: override(to, 'to'),
            cc: override(cc, 'cc'),
            subject: override(subject, 'subject'),
            body: override(body, 'body'),
            fromEmail: override(fromEmail, 'fromEmail'),
            fromName: override(fromName, 'fromName'),
          }),
        )
        toast.success(`Sent to ${res.to}`)
      }
      onSent()
      close()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send')
    }
  }

  const templateStatus = preview.isLoading
    ? 'Loading the platform’s template…'
    : preview.data
      ? 'Loaded the platform’s template — send as-is for the exact format, or edit any field.'
      : 'No template preview available — leave fields blank to use the platform’s default.'

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={
        isReminder
          ? `Send reminder${invoiceNumber ? ` — ${invoiceNumber}` : ''}`
          : `Email invoice${invoiceNumber ? ` — ${invoiceNumber}` : ''}`
      }
      dismissable={!pending}
      footer={
        <>
          <Button type="button" size="sm" variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={pending}>
            {pending ? 'Sending…' : isReminder ? 'Send reminder' : 'Send invoice'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          {templateStatus} The PDF is attached automatically.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="To" hint="Blank = customer’s contact email.">
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@example.com" />
          </Field>
          <Field label="Cc" hint="Comma-separated.">
            <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="a@x.com, b@y.com" />
          </Field>
        </div>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="(platform default)" />
        </Field>
        <Field label="Message">
          <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="(platform default)" />
        </Field>
        {isReminder ? (
          <label className="flex items-center gap-2 text-xs text-neutral-600">
            <input type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} />
            Attach the invoice PDF
          </label>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From email (override)">
              <Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="(default)" />
            </Field>
            <Field label="From name (override)">
              <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="(default)" />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  )
}
