// Live invoicing panel for a BusinessAccount (and, with a contact target, a B2C
// Contact). Lists invoices mirrored from the B2B Invoices Platform and drives
// every action from inside the CRM — raise / edit (full field parity) / preview
// PDF / email / reminder (compose) / record + remove payment / issue / reissue /
// duplicate / cancel / mark paid (ADR 0036). Money is GBP-from-pence (§19, §29).
//
// Roles are enforced server-side; the UI hides actions a role can't use but
// never relies on that for security (CLAUDE.md §20).

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { Modal } from '@/components/ui/modal'
import { trpc, type RouterOutputs } from '@/lib/trpc/client'

import { InvoiceActivityModal } from './InvoiceActivityModal'
import { InvoiceComposeModal, type ComposeMode } from './InvoiceComposeModal'
import { InvoicePdfPreview, invoicePdfUrl } from './InvoicePdfPreview'
import {
  RaiseInvoiceForm,
  type ClientType,
  type EditableInvoice,
  type InvoiceTarget,
} from './RaiseInvoiceForm'

function money(minor: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}

function timeAgo(d: Date | string | null): string {
  if (!d) return ''
  const ms = Date.now() - new Date(d).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
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

type InvoiceRow = RouterOutputs['invoicing']['invoices']['list'][number]

function toEditable(inv: InvoiceRow): EditableInvoice {
  return {
    invoicingId: inv.invoicingId,
    invoiceNumber: inv.invoiceNumber,
    clientType: inv.clientType,
    currency: inv.currency,
    pricesIncludeVat: inv.pricesIncludeVat,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    poNumber: inv.poNumber,
    paymentReference: inv.paymentReference,
    paymentTerms: inv.paymentTerms,
    billToName: inv.billToName,
    fromEmail: inv.fromEmail,
    notes: inv.notes,
    internalNotes: inv.internalNotes,
    lineItems: inv.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPriceMinor: li.unitPriceMinor,
      vatRate: li.vatRate,
    })),
  }
}

export function AccountInvoicingPanel({
  target,
  canWrite,
  canMarkPaid,
  defaultClientType = 'uk_b2b',
}: {
  target: InvoiceTarget
  canWrite: boolean
  canMarkPaid: boolean
  defaultClientType?: ClientType
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const listInput =
    target.kind === 'businessAccount'
      ? { businessAccountId: target.businessAccountId }
      : { contactId: target.contactId }
  const invoicesQuery = trpc.invoicing.invoices.list.useQuery(listInput)

  const recordPayment = trpc.invoicing.invoices.recordPayment.useMutation()
  const markPaid = trpc.invoicing.invoices.markPaid.useMutation()
  const issue = trpc.invoicing.invoices.issue.useMutation()
  const reissue = trpc.invoicing.invoices.reissue.useMutation()
  const duplicate = trpc.invoicing.invoices.duplicate.useMutation()
  const cancel = trpc.invoicing.invoices.cancel.useMutation()
  const removePayment = trpc.invoicing.invoices.removePayment.useMutation()

  const [showRaise, setShowRaise] = useState(false)
  const [editing, setEditing] = useState<InvoiceRow | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewNumber, setPreviewNumber] = useState<string | null>(null)
  const [compose, setCompose] = useState<{
    mode: ComposeMode
    invoicingId: string
    invoiceNumber: string | null
  } | null>(null)
  const [activityInv, setActivityInv] = useState<InvoiceRow | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function refresh() {
    await invoicesQuery.refetch()
    router.refresh()
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
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record payment')
    }
  }

  async function handleMarkPaid(invoicingId: string) {
    if (!(await confirm({ title: 'Mark this invoice as fully paid?', confirmLabel: 'Mark paid' }))) return
    try {
      await markPaid.mutateAsync({ invoicingId })
      toast.success('Invoice marked paid')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not mark paid')
    }
  }

  async function handleIssue(invoicingId: string) {
    try {
      await issue.mutateAsync({ invoicingId })
      toast.success('Invoice issued')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not issue invoice')
    }
  }

  async function handleReissue(invoicingId: string) {
    if (!(await confirm({ title: 'Reissue with today’s date?', confirmLabel: 'Reissue' }))) return
    try {
      await reissue.mutateAsync({ invoicingId })
      toast.success('Invoice reissued')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reissue')
    }
  }

  async function handleDuplicate(invoicingId: string) {
    try {
      const res = await duplicate.mutateAsync({ invoicingId })
      toast.success(`Duplicated as ${res.invoiceNumber ?? 'new draft'}`)
      await refresh()
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
      await refresh()
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
      await refresh()
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
          <Button type="button" size="sm" onClick={() => setShowRaise(true)}>
            Raise invoice
          </Button>
        )}
      </div>

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
            const isPaid = inv.status === 'paid'
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
                      {money(inv.grandTotalMinor, inv.currency)} total
                      {inv.paidMinor > 0 && ` · ${money(inv.paidMinor, inv.currency)} paid`}
                      {outstanding > 0 && ` · ${money(outstanding, inv.currency)} due`}
                    </div>
                    {(inv.lastEmailedAt || inv.lastReminderAt) && (
                      <div className="mt-0.5 text-[11px] text-neutral-400">
                        {inv.lastEmailedAt && `Emailed ${timeAgo(inv.lastEmailedAt)}`}
                        {inv.lastEmailedAt && inv.lastReminderAt && ' · '}
                        {inv.lastReminderAt && `Reminded ${timeAgo(inv.lastReminderAt)}`}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPreviewId(inv.invoicingId)
                        setPreviewNumber(inv.invoiceNumber)
                      }}
                    >
                      Preview PDF
                    </Button>
                    {canWrite && !isCancelled && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setCompose({
                            mode: 'send',
                            invoicingId: inv.invoicingId,
                            invoiceNumber: inv.invoiceNumber,
                          })
                        }
                      >
                        Email
                      </Button>
                    )}
                    {canWrite && !isPaid && !isCancelled && (
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
                    {canMarkPaid && !isPaid && !isCancelled && (
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
                    {inv.payments.length > 0 && (
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                          Payments &amp; adjustments
                        </p>
                        <ul className="mt-1 space-y-1">
                          {inv.payments.map((p) => (
                            <li
                              key={p.id}
                              className="flex items-center justify-between gap-2 text-xs text-neutral-700"
                            >
                              <span>
                                {money(p.amountMinor, inv.currency)}
                                {p.reference ? ` · ${p.reference}` : ''}
                                {!p.reference && p.method ? ` · ${p.method.replace('_', ' ')}` : ''}
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

                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setActivityInv(inv)}
                      >
                        Email history
                      </Button>
                      <a
                        href={invoicePdfUrl(inv.invoicingId, true)}
                        className="rounded-md px-2 py-1 text-xs text-primary-700 hover:bg-white hover:underline"
                      >
                        Download PDF
                      </a>
                      {canWrite && !isCancelled && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(inv)}
                        >
                          Edit
                        </Button>
                      )}
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
                      {canWrite && !isDraft && !isCancelled && !isPaid && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setCompose({
                              mode: 'reminder',
                              invoicingId: inv.invoicingId,
                              invoiceNumber: inv.invoiceNumber,
                            })
                          }
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

      {/* Raise (create) */}
      <Modal
        open={showRaise}
        onClose={() => setShowRaise(false)}
        size="xl"
        title="Raise invoice"
        dismissable={false}
      >
        {showRaise && (
          <RaiseInvoiceForm
            mode="create"
            target={target}
            defaultClientType={defaultClientType}
            onDone={() => {
              setShowRaise(false)
              void invoicesQuery.refetch()
            }}
            onCancel={() => setShowRaise(false)}
          />
        )}
      </Modal>

      {/* Edit */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="xl"
        title={`Edit invoice${editing?.invoiceNumber ? ` — ${editing.invoiceNumber}` : ''}`}
        dismissable={false}
      >
        {editing && (
          <RaiseInvoiceForm
            mode="edit"
            invoice={toEditable(editing)}
            onDone={() => {
              setEditing(null)
              void invoicesQuery.refetch()
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      {/* PDF preview */}
      <InvoicePdfPreview
        invoicingId={previewId}
        invoiceNumber={previewNumber}
        onClose={() => setPreviewId(null)}
      />

      {/* Email / reminder compose */}
      <InvoiceComposeModal
        mode={compose?.mode ?? null}
        invoicingId={compose?.invoicingId ?? null}
        invoiceNumber={compose?.invoiceNumber ?? null}
        onClose={() => setCompose(null)}
        onSent={() => void invoicesQuery.refetch()}
      />

      {/* Email & activity history */}
      <InvoiceActivityModal
        invoicingId={activityInv?.invoicingId ?? null}
        invoiceNumber={activityInv?.invoiceNumber ?? null}
        lastEmailedAt={activityInv?.lastEmailedAt ?? null}
        lastReminderAt={activityInv?.lastReminderAt ?? null}
        onClose={() => setActivityInv(null)}
      />
    </div>
  )
}
