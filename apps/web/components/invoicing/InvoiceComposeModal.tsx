// Compose modal for emailing an invoice or a payment reminder from the CRM.
// Lets the user edit to / cc / subject / body (all optional overrides — blank
// falls back to the platform's defaults: the customer's contact email + the
// standard template) before POSTing to /invoices/:id/send or /send-reminder.
// Both attach the same PDF the preview shows (ADR 0036).

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

export type ComposeMode = 'send' | 'reminder'

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

  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [attachPdf, setAttachPdf] = useState(true)

  const open = mode !== null && invoicingId !== null
  const isReminder = mode === 'reminder'
  const pending = send.isPending || reminder.isPending

  function reset() {
    setTo('')
    setCc('')
    setSubject('')
    setBody('')
    setFromEmail('')
    setFromName('')
    setAttachPdf(true)
  }

  function close() {
    reset()
    onClose()
  }

  async function submit() {
    if (!invoicingId) return
    try {
      if (isReminder) {
        const res = await reminder.mutateAsync({
          invoicingId,
          ...(to.trim() ? { to: to.trim() } : {}),
          ...(cc.trim() ? { cc: cc.trim() } : {}),
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          ...(body.trim() ? { body: body.trim() } : {}),
          attachPdf,
        })
        toast.success(`Reminder sent to ${res.to}`)
      } else {
        const res = await send.mutateAsync({
          invoicingId,
          ...(to.trim() ? { to: to.trim() } : {}),
          ...(cc.trim() ? { cc: cc.trim() } : {}),
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          ...(body.trim() ? { body: body.trim() } : {}),
          ...(fromEmail.trim() ? { fromEmail: fromEmail.trim() } : {}),
          ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
        })
        toast.success(`Sent to ${res.to}`)
      }
      onSent()
      close()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send')
    }
  }

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
        <p className="text-xs text-neutral-500">
          Leave any field blank to use the platform default ({isReminder ? 'chaser' : 'invoice'}{' '}
          template, sent to the customer’s contact email). The PDF is attached automatically.
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
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="(default subject)" />
        </Field>
        <Field label="Message">
          <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="(default message)" />
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
