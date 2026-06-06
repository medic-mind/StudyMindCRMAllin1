// Full create/edit invoice form for the B2B Invoices Platform — parity with the
// B2B site's raise screen (ADR 0036). Exposes every write field: client type
// (incl. Alternative Provision / council), the VAT mode toggle, billing company
// + bank account (from GET /billing-companies, /bank-accounts), currency, dates,
// bill-to, PO / payment ref / terms, printed + internal notes, repeatable line
// items, and — on create — an "Adjustments / already paid" section recorded as
// platform payments. Money is entered in major units and converted to integer
// pence at the boundary (CLAUDE.md §19). Roles enforced server-side.

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

export type InvoiceTarget =
  | { kind: 'businessAccount'; businessAccountId: string }
  | { kind: 'contact'; contactId: string }

export type ClientType = 'uk_b2b' | 'international' | 'summer_school' | 'school' | 'alt_provision'

const CLIENT_TYPE_OPTIONS: { value: ClientType; label: string }[] = [
  { value: 'uk_b2b', label: 'UK B2B' },
  { value: 'international', label: 'International B2B' },
  { value: 'summer_school', label: 'B2B Summer School' },
  { value: 'school', label: 'B2B School' },
  { value: 'alt_provision', label: 'Alternative Provision (Council)' },
]

const CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD', 'AED', 'SGD']
const PAYMENT_METHODS = ['other', 'bank_transfer', 'card', 'cheque'] as const

interface LineDraft {
  description: string
  quantity: string
  unitPrice: string
  vatRate: string
}

interface AdjustmentDraft {
  amount: string
  date: string
  method: (typeof PAYMENT_METHODS)[number]
  description: string
}

/** Invoice shape the form reads when editing (a row from invoicing.invoices.list). */
export interface EditableInvoice {
  invoicingId: string
  invoiceNumber: string | null
  clientType: string
  currency: string
  pricesIncludeVat: boolean | null
  issueDate: string | Date | null
  dueDate: string | Date | null
  poNumber: string | null
  paymentReference: string | null
  paymentTerms: string | null
  billToName: string | null
  fromEmail: string | null
  notes: string | null
  internalNotes: string | null
  lineItems: {
    description: string
    quantity: string
    unitPriceMinor: number
    vatRate: number | null
  }[]
}

function toDateInput(d: string | Date | null | undefined): string {
  if (!d) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

function isClientType(v: string): v is ClientType {
  return CLIENT_TYPE_OPTIONS.some((o) => o.value === v)
}

function newLine(): LineDraft {
  return { description: '', quantity: '1', unitPrice: '', vatRate: '20' }
}

export function RaiseInvoiceForm({
  mode,
  target,
  isAlternativeProvision,
  defaultClientType = 'uk_b2b',
  invoice,
  onDone,
  onCancel,
}: {
  mode: 'create' | 'edit'
  /** Required in create mode. */
  target?: InvoiceTarget
  isAlternativeProvision?: boolean
  defaultClientType?: ClientType
  /** Required in edit mode. */
  invoice?: EditableInvoice
  onDone: () => void
  onCancel: () => void
}) {
  const router = useRouter()
  const raise = trpc.invoicing.invoices.raise.useMutation()
  const edit = trpc.invoicing.invoices.edit.useMutation()

  // Reference data — best-effort; if the platform endpoint errors or returns
  // nothing we just bill from the platform's own defaults.
  const billingCompanies = trpc.invoicing.reference.billingCompanies.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  })
  const bankAccounts = trpc.invoicing.reference.bankAccounts.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  })

  const initialClientType: ClientType =
    invoice && isClientType(invoice.clientType) ? invoice.clientType : defaultClientType

  const [clientType, setClientType] = useState<ClientType>(initialClientType)
  const [pricesIncludeVat, setPricesIncludeVat] = useState<boolean>(
    invoice?.pricesIncludeVat ?? false,
  )
  const [currency, setCurrency] = useState(invoice?.currency || 'GBP')
  const [billingCompanyId, setBillingCompanyId] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [issueDate, setIssueDate] = useState(toDateInput(invoice?.issueDate))
  const [dueDate, setDueDate] = useState(toDateInput(invoice?.dueDate))
  const [billToName, setBillToName] = useState(invoice?.billToName ?? '')
  const [poNumber, setPoNumber] = useState(invoice?.poNumber ?? '')
  const [fromEmail, setFromEmail] = useState(invoice?.fromEmail ?? '')
  const [paymentReference, setPaymentReference] = useState(
    invoice?.paymentReference ?? (invoice?.invoiceNumber ? invoice.invoiceNumber.replace(/-/g, '') : ''),
  )
  const [paymentTerms, setPaymentTerms] = useState(invoice?.paymentTerms ?? '')
  const [notes, setNotes] = useState(invoice?.notes ?? '')
  const [internalNotes, setInternalNotes] = useState(invoice?.internalNotes ?? '')
  const [draft, setDraft] = useState(false)

  const [lines, setLines] = useState<LineDraft[]>(
    invoice
      ? invoice.lineItems.map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitPrice: (li.unitPriceMinor / 100).toFixed(2),
          vatRate: li.vatRate == null ? '' : String(li.vatRate),
        }))
      : [newLine()],
  )
  const [adjustments, setAdjustments] = useState<AdjustmentDraft[]>([])

  const isInternational = clientType === 'international'

  // Default-select the platform's default billing company + bank account once
  // the reference data lands (create mode only — edit keeps the platform's).
  useEffect(() => {
    if (mode !== 'create') return
    const rows = billingCompanies.data
    if (rows && rows.length && !billingCompanyId) {
      setBillingCompanyId((rows.find((r) => r.isDefault) ?? rows[0])?.id ?? '')
    }
  }, [mode, billingCompanies.data, billingCompanyId])

  useEffect(() => {
    if (mode !== 'create') return
    const rows = bankAccounts.data
    if (rows && rows.length && !bankAccountId) {
      setBankAccountId((rows.find((r) => r.isDefault) ?? rows[0])?.id ?? '')
    }
  }, [mode, bankAccounts.data, bankAccountId])

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function updateAdjustment(i: number, patch: Partial<AdjustmentDraft>) {
    setAdjustments((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))
  }

  const parsedLines = useMemo(
    () =>
      lines
        .filter((l) => l.description.trim() && l.unitPrice.trim())
        .map((l) => ({
          description: l.description.trim(),
          quantity: Number(l.quantity) || 1,
          unitPriceMinor: Math.round(Number(l.unitPrice) * 100),
          // International is VAT-free: force 0 on every line.
          vatRate: isInternational ? 0 : l.vatRate.trim() ? Math.round(Number(l.vatRate)) : 0,
        })),
    [lines, isInternational],
  )

  async function submit() {
    if (parsedLines.length === 0) {
      toast.error('Add at least one line item with a description and price.')
      return
    }
    const sharedFields = {
      clientType,
      currency,
      // International → prices_include_vat:false (VAT-free); otherwise the toggle.
      pricesIncludeVat: isInternational ? false : pricesIncludeVat,
      ...(issueDate ? { issueDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(poNumber.trim() ? { poNumber: poNumber.trim() } : {}),
      ...(paymentReference.trim() ? { paymentReference: paymentReference.trim() } : {}),
      ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}),
      ...(billToName.trim() ? { billToName: billToName.trim() } : {}),
      ...(fromEmail.trim() ? { fromEmail: fromEmail.trim() } : {}),
      ...(billingCompanyId ? { billingCompanyId } : {}),
      ...(bankAccountId ? { bankAccountId } : {}),
      notes: notes.trim(),
      internalNotes: internalNotes.trim(),
    }

    try {
      if (mode === 'edit' && invoice) {
        await edit.mutateAsync({
          invoicingId: invoice.invoicingId,
          lineItems: parsedLines,
          ...sharedFields,
        })
        toast.success('Invoice updated')
      } else if (target) {
        const base =
          target.kind === 'businessAccount'
            ? { businessAccountId: target.businessAccountId }
            : { contactId: target.contactId }
        const parsedAdjustments = adjustments
          .filter((a) => a.amount.trim() && Number(a.amount) > 0)
          .map((a) => ({
            amountMinor: Math.round(Number(a.amount) * 100),
            ...(a.date ? { date: a.date } : {}),
            method: a.method,
            ...(a.description.trim() ? { description: a.description.trim() } : {}),
          }))
        const result = await raise.mutateAsync({
          ...base,
          ...(isAlternativeProvision ? { isAlternativeProvision } : {}),
          lineItems: parsedLines,
          ...(parsedAdjustments.length ? { adjustments: parsedAdjustments } : {}),
          ...(draft ? { draft } : {}),
          ...sharedFields,
        })
        toast.success(`Invoice ${result.invoiceNumber ?? 'raised'} created`)
      }
      onDone()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save invoice')
    }
  }

  const pending = raise.isPending || edit.isPending

  return (
    <div className="space-y-5 p-4">
      {/* Type + VAT */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Client type" hint="Drives VAT + which letterhead prints.">
          <Select value={clientType} onChange={(e) => setClientType(e.target.value as ClientType)}>
            {CLIENT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

        {isInternational ? (
          <Field label="VAT" hint="International is VAT-free — no VAT on the invoice or PDF.">
            <div className="flex h-9 items-center text-sm text-neutral-500">VAT-free (0%)</div>
          </Field>
        ) : (
          <Field label="VAT mode">
            <Select
              value={pricesIncludeVat ? 'inclusive' : 'exclusive'}
              onChange={(e) => setPricesIncludeVat(e.target.value === 'inclusive')}
            >
              <option value="exclusive">Add VAT on top (prices are net)</option>
              <option value="inclusive">Prices include VAT (gross — VAT extracted)</option>
            </Select>
          </Field>
        )}
      </div>

      {/* Billing company + bank + currency */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Billing company" hint="Letterhead + VAT number on the PDF.">
          <Select value={billingCompanyId} onChange={(e) => setBillingCompanyId(e.target.value)}>
            <option value="">Platform default</option>
            {(billingCompanies.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.id}
                {c.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bank account" hint="Bank details on the PDF.">
          <Select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
            <option value="">Platform default</option>
            {(bankAccounts.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name ?? b.id}
                {b.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency">
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Dates + refs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Issue date">
          <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </Field>
        <Field label="Due date">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Bill to (override name)" hint="Blank = use the customer's name.">
          <Input value={billToName} onChange={(e) => setBillToName(e.target.value)} placeholder="e.g. Acme Holdings Ltd" />
        </Field>
        <Field label="PO number">
          <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-12345" />
        </Field>
        <Field label="Invoice-from email">
          <Input
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="finance@studymind.co.uk"
          />
        </Field>
        <Field label="Payment reference" hint="Defaults to the invoice number without dashes.">
          <Input
            value={paymentReference}
            onChange={(e) => setPaymentReference(e.target.value)}
            placeholder="INV1042"
          />
        </Field>
      </div>

      <Field label="Payment terms">
        <Input
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          placeholder="Payment due within 30 days"
        />
      </Field>

      {/* Line items */}
      <div>
        <p className="mb-1 text-sm font-medium text-neutral-800">Line items</p>
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
                className={isInternational ? 'col-span-4' : 'col-span-2'}
                type="number"
                placeholder="Unit £"
                value={line.unitPrice}
                onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
              />
              {!isInternational && (
                <Input
                  className="col-span-2"
                  type="number"
                  placeholder="VAT %"
                  value={line.vatRate}
                  onChange={(e) => updateLine(i, { vatRate: e.target.value })}
                />
              )}
              <button
                type="button"
                className="col-span-1 text-neutral-400 hover:text-red-600"
                onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))}
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
          onClick={() => setLines((prev) => [...prev, newLine()])}
        >
          + Add line
        </button>
      </div>

      {/* Adjustments / already paid (create only) */}
      {mode === 'create' && (
        <div>
          <p className="mb-1 text-sm font-medium text-neutral-800">
            Adjustments / already paid <span className="font-normal text-neutral-500">(optional)</span>
          </p>
          <p className="mb-2 text-xs text-neutral-500">
            Discounts, credits, or prior payments. Each is recorded as a deduction and drops the
            total due (e.g. “Discount – Referral  −£50.00”).
          </p>
          <div className="space-y-2">
            {adjustments.map((a, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Input
                  className="col-span-5"
                  placeholder="Description (e.g. Discount – Referral)"
                  value={a.description}
                  onChange={(e) => updateAdjustment(i, { description: e.target.value })}
                />
                <Input
                  className="col-span-2"
                  type="number"
                  placeholder="£"
                  value={a.amount}
                  onChange={(e) => updateAdjustment(i, { amount: e.target.value })}
                />
                <Input
                  className="col-span-2"
                  type="date"
                  value={a.date}
                  onChange={(e) => updateAdjustment(i, { date: e.target.value })}
                />
                <Select
                  className="col-span-2"
                  value={a.method}
                  onChange={(e) =>
                    updateAdjustment(i, { method: e.target.value as AdjustmentDraft['method'] })
                  }
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m.replace('_', ' ')}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  className="col-span-1 text-neutral-400 hover:text-red-600"
                  onClick={() => setAdjustments((prev) => prev.filter((_, idx) => idx !== i))}
                  aria-label="Remove adjustment"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-primary-700 hover:underline"
            onClick={() =>
              setAdjustments((prev) => [
                ...prev,
                { amount: '', date: '', method: 'other', description: '' },
              ])
            }
          >
            + Add adjustment
          </button>
        </div>
      )}

      {/* Notes */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Notes (printed on the invoice)">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Field label="Internal notes (not printed)">
          <Textarea rows={3} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-3">
        {mode === 'create' ? (
          <label className="flex items-center gap-2 text-xs text-neutral-600">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Save as draft (don’t issue yet)
          </label>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Create invoice'}
          </Button>
        </div>
      </div>
    </div>
  )
}
