// Live invoicing panel for a BusinessAccount (and, with `contactId`, a B2C
// Contact). Lists invoices mirrored from the B2B Invoices Platform and lets an
// agent raise / send / record-payment / mark-paid from inside the CRM. Money
// is shown in GBP from integer minor units (CLAUDE.md §19, §29).
//
// Roles are enforced server-side; the UI hides actions a Virtual Assistant
// cannot use, but never relies on that for security (CLAUDE.md §20).

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { trpc } from '@/lib/trpc/client'

type Target =
  | { kind: 'businessAccount'; businessAccountId: string }
  | { kind: 'contact'; contactId: string }

interface LineDraft {
  description: string
  quantity: string
  unitPrice: string
  vatRate: string
}

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })
function money(minor: number): string {
  return gbp.format(minor / 100)
}

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-neutral-100 text-neutral-700',
  issued: 'bg-blue-50 text-blue-800',
  partially_paid: 'bg-amber-50 text-amber-800',
  paid: 'bg-emerald-50 text-emerald-800',
  overdue: 'bg-red-50 text-red-700',
  cancelled: 'bg-neutral-100 text-neutral-500',
  unknown: 'bg-neutral-100 text-neutral-500',
}

export function AccountInvoicingPanel({
  target,
  canWrite,
  canMarkPaid,
}: {
  target: Target
  canWrite: boolean
  canMarkPaid: boolean
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const listInput =
    target.kind === 'businessAccount'
      ? { businessAccountId: target.businessAccountId }
      : { contactId: target.contactId }
  const invoicesQuery = trpc.invoicing.invoices.list.useQuery(listInput)

  const raise = trpc.invoicing.invoices.raise.useMutation()
  const send = trpc.invoicing.invoices.send.useMutation()
  const recordPayment = trpc.invoicing.invoices.recordPayment.useMutation()
  const markPaid = trpc.invoicing.invoices.markPaid.useMutation()
  const issue = trpc.invoicing.invoices.issue.useMutation()
  const sendReminder = trpc.invoicing.invoices.sendReminder.useMutation()
  const reissue = trpc.invoicing.invoices.reissue.useMutation()
  const duplicate = trpc.invoicing.invoices.duplicate.useMutation()
  const cancel = trpc.invoicing.invoices.cancel.useMutation()
  const removePayment = trpc.invoicing.invoices.removePayment.useMutation()

  const [previewId, setPreviewId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function pdfUrl(invoicingId: string, download = false): string {
    const base = `/api/internal/invoicing/invoices/${encodeURIComponent(invoicingId)}/pdf`
    return download ? `${base}?download=1` : base
  }

  const [showRaise, setShowRaise] = useState(false)
  const [poNumber, setPoNumber] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [pricesIncludeVat, setPricesIncludeVat] = useState(false)
  const [lines, setLines] = useState<LineDraft[]>([
    { description: '', quantity: '1', unitPrice: '', vatRate: '20' },
  ])

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, { description: '', quantity: '1', unitPrice: '', vatRate: '20' }])
  }
  function removeLine(i: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))
  }

  async function submitRaise() {
    const parsedLines = lines
      .filter((l) => l.description.trim() && l.unitPrice.trim())
      .map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity) || 1,
        // Convert the typed major-unit price to integer pence without float drift.
        unitPriceMinor: Math.round(Number(l.unitPrice) * 100),
        ...(l.vatRate.trim() ? { vatRate: Math.round(Number(l.vatRate)) } : {}),
      }))
    if (parsedLines.length === 0) {
      toast.error('Add at least one line item with a description and price.')
      return
    }
    try {
      const base =
        target.kind === 'businessAccount'
          ? { businessAccountId: target.businessAccountId }
          : { contactId: target.contactId }
      const result = await raise.mutateAsync({
        ...base,
        lineItems: parsedLines,
        pricesIncludeVat,
        ...(dueDate ? { dueDate } : {}),
        ...(poNumber.trim() ? { poNumber: poNumber.trim() } : {}),
      })
      toast.success(`Invoice ${result.invoiceNumber ?? 'raised'} created`)
      setShowRaise(false)
      setLines([{ description: '', quantity: '1', unitPrice: '', vatRate: '20' }])
      setPoNumber('')
      setDueDate('')
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not raise invoice')
    }
  }

  async function handleSend(invoicingId: string) {
    try {
      const res = await send.mutateAsync({ invoicingId })
      toast.success(`Sent to ${res.to}`)
      await invoicesQuery.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send invoice')
    }
  }

  async function handleRecordPayment(invoicingId: string, outstandingMinor: number) {
    const input = window.prompt(
      'Payment amount in £ (e.g. 200.00):',
      (outstandingMinor / 100).toFixed(2),
    )
    if (input === null) return
    const amountMinor = Math.round(Number(input) * 100)
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      toast.error('Enter a positive amount.')
      return
    }
    try {
      await recordPayment.mutateAsync({ invoicingId, amountMinor, method: 'bank_transfer' })
      toast.success('Payment recorded')
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record payment')
    }
  }

  async function handleMarkPaid(invoicingId: string) {
    if (!(await confirm({ title: 'Mark this invoice as fully paid?', confirmLabel: 'Mark paid' }))) return
    try {
      await markPaid.mutateAsync({ invoicingId })
      toast.success('Invoice marked paid')
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not mark paid')
    }
  }

  async function handleIssue(invoicingId: string) {
    try {
      await issue.mutateAsync({ invoicingId })
      toast.success('Invoice issued')
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not issue invoice')
    }
  }

  async function handleReminder(invoicingId: string) {
    try {
      const res = await sendReminder.mutateAsync({ invoicingId })
      toast.success(`Reminder sent to ${res.to}`)
      await invoicesQuery.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send reminder')
    }
  }

  async function handleReissue(invoicingId: string) {
    if (!(await confirm({ title: 'Reissue with today’s date?', confirmLabel: 'Reissue' }))) return
    try {
      await reissue.mutateAsync({ invoicingId })
      toast.success('Invoice reissued')
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reissue')
    }
  }

  async function handleDuplicate(invoicingId: string) {
    try {
      const res = await duplicate.mutateAsync({ invoicingId })
      toast.success(`Duplicated as ${res.invoiceNumber ?? 'new draft'}`)
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not duplicate')
    }
  }

  async function handleCancel(invoicingId: string) {
    if (
      !(await confirm({
        title: 'Cancel (void) this invoice?',
        body: 'This voids the invoice on the platform. It cannot be un-cancelled.',
        confirmLabel: 'Cancel invoice',
        tone: 'danger',
      }))
    )
      return
    try {
      await cancel.mutateAsync({ invoicingId })
      toast.success('Invoice cancelled')
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not cancel')
    }
  }

  async function handleRemovePayment(invoicingId: string, paymentInvoicingId: string) {
    if (
      !(await confirm({
        title: 'Remove this payment?',
        body: 'The invoice status will be recomputed on the platform.',
        confirmLabel: 'Remove payment',
        tone: 'danger',
      }))
    )
      return
    try {
      await removePayment.mutateAsync({ invoicingId, paymentInvoicingId })
      toast.success('Payment removed')
      await invoicesQuery.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove payment')
    }
  }

  const invoices = invoicesQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500">Synced live with the B2B Invoices Platform.</p>
        {canWrite && (
          <Button type="button" size="sm" onClick={() => setShowRaise((s) => !s)}>
            {showRaise ? 'Cancel' : 'Raise invoice'}
          </Button>
        )}
      </div>

      {showRaise && canWrite && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Input
                  className="col-span-5"
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                />
                <Input
                  className="col-span-2"
                  type="number"
                  placeholder="Qty"
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                />
                <Input
                  className="col-span-2"
                  type="number"
                  placeholder="Unit £"
                  value={line.unitPrice}
                  onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                />
                <Input
                  className="col-span-2"
                  type="number"
                  placeholder="VAT %"
                  value={line.vatRate}
                  onChange={(e) => updateLine(i, { vatRate: e.target.value })}
                />
                <button
                  type="button"
                  className="col-span-1 text-neutral-400 hover:text-red-600"
                  onClick={() => removeLine(i)}
                  aria-label="Remove line"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-primary-700 hover:underline"
            onClick={addLine}
          >
            + Add line
          </button>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Input
              placeholder="PO number (optional)"
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
            />
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={pricesIncludeVat}
              onChange={(e) => setPricesIncludeVat(e.target.checked)}
            />
            Prices include VAT (gross). Unticked = net, VAT added on top.
          </label>

          <div className="mt-3">
            <Button type="button" size="sm" disabled={raise.isPending} onClick={submitRaise}>
              {raise.isPending ? 'Raising…' : 'Create invoice'}
            </Button>
          </div>
        </div>
      )}

      {invoicesQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading invoices…</p>
      ) : invoices.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No invoices yet. {canWrite ? 'Raise one to bill this customer.' : ''}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
          {invoices.map((inv) => {
            const outstanding = Math.max(0, inv.grandTotalMinor - inv.paidMinor)
            const isOpen = expanded.has(inv.id)
            const isDraft = inv.status === 'draft'
            const isCancelled = inv.status === 'cancelled'
            return (
              <li key={inv.id} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-neutral-900">
                        {inv.invoiceNumber ?? 'draft'}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[inv.status] ?? STATUS_TONE['unknown']}`}
                      >
                        {inv.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-500">
                      {money(inv.grandTotalMinor)} total
                      {inv.paidMinor > 0 && ` · ${money(inv.paidMinor)} paid`}
                      {outstanding > 0 && ` · ${money(outstanding)} due`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setPreviewId(inv.invoicingId)}
                    >
                      Preview PDF
                    </Button>
                    {canWrite && !isCancelled && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={send.isPending}
                        onClick={() => handleSend(inv.invoicingId)}
                      >
                        Send
                      </Button>
                    )}
                    {canWrite && inv.status !== 'paid' && !isCancelled && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={recordPayment.isPending}
                        onClick={() => handleRecordPayment(inv.invoicingId, outstanding)}
                      >
                        Record payment
                      </Button>
                    )}
                    {canMarkPaid && inv.status !== 'paid' && !isCancelled && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={markPaid.isPending}
                        onClick={() => handleMarkPaid(inv.invoicingId)}
                      >
                        Mark paid
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-expanded={isOpen}
                      onClick={() => toggleExpanded(inv.id)}
                    >
                      {isOpen ? 'Less' : 'More'}
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-3 space-y-3 rounded-md bg-neutral-50 p-3">
                    {/* Recorded payments + per-payment remove */}
                    {inv.payments.length > 0 && (
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                          Payments
                        </p>
                        <ul className="mt-1 space-y-1">
                          {inv.payments.map((p) => (
                            <li
                              key={p.id}
                              className="flex items-center justify-between gap-2 text-xs text-neutral-700"
                            >
                              <span>
                                {money(p.amountMinor)}
                                {p.method ? ` · ${p.method.replace('_', ' ')}` : ''}
                                {p.reference ? ` · ${p.reference}` : ''}
                              </span>
                              {canMarkPaid && (
                                <button
                                  type="button"
                                  className="text-neutral-400 hover:text-red-600"
                                  disabled={removePayment.isPending}
                                  onClick={() => handleRemovePayment(inv.invoicingId, p.invoicingId)}
                                >
                                  Remove
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Secondary actions */}
                    <div className="flex flex-wrap items-center gap-1">
                      <a
                        href={pdfUrl(inv.invoicingId, true)}
                        className="rounded-md px-2 py-1 text-xs text-primary-700 hover:bg-white hover:underline"
                      >
                        Download PDF
                      </a>
                      {canWrite && isDraft && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={issue.isPending}
                          onClick={() => handleIssue(inv.invoicingId)}
                        >
                          Issue
                        </Button>
                      )}
                      {canWrite && !isDraft && !isCancelled && inv.status !== 'paid' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={sendReminder.isPending}
                          onClick={() => handleReminder(inv.invoicingId)}
                        >
                          Send reminder
                        </Button>
                      )}
                      {canWrite && !isCancelled && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={reissue.isPending}
                          onClick={() => handleReissue(inv.invoicingId)}
                        >
                          Reissue
                        </Button>
                      )}
                      {canWrite && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={duplicate.isPending}
                          onClick={() => handleDuplicate(inv.invoicingId)}
                        >
                          Duplicate
                        </Button>
                      )}
                      {canMarkPaid && !isCancelled && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:bg-red-50"
                          disabled={cancel.isPending}
                          onClick={() => handleCancel(inv.invoicingId)}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Inline PDF preview — byte-identical to what the client receives. The
          iframe points at the server-side proxy so the API key stays on the
          backend. */}
      <Modal
        open={previewId !== null}
        onClose={() => setPreviewId(null)}
        size="xl"
        title="Invoice PDF"
        footer={
          previewId ? (
            <>
              <a
                href={pdfUrl(previewId, true)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-primary-700 hover:underline"
              >
                Download
              </a>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPreviewId(null)}>
                Close
              </Button>
            </>
          ) : null
        }
      >
        {previewId && (
          <iframe
            title="Invoice PDF preview"
            src={pdfUrl(previewId)}
            className="h-[70vh] w-full border-0"
          />
        )}
      </Modal>
    </div>
  )
}
