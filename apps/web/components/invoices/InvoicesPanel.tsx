// Reusable invoices panel. Mounted on the BusinessAccount detail page, the
// Contact detail page, and the Family detail page — the only thing that
// changes between mounts is which owner key is set.
//
// The agent can:
//   - upload a new invoice (PDF / image / Excel, max 8 MB) with metadata
//     (number, amount, status, issued / due dates, notes)
//   - update the metadata on an existing row
//   - open the file inline in another tab
//   - archive / restore / delete (Manager+ for delete)
//
// Cross-app connectivity with b2b.studymind.co.uk is a follow-up PR; today
// this is the canonical upload + browse + audit surface.

'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Status = 'draft' | 'sent' | 'paid' | 'overdue' | 'void'

export type InvoiceTarget =
  | { kind: 'businessAccount'; businessAccountId: string }
  | { kind: 'contact'; contactId: string }
  | { kind: 'family'; familyId: string }

const ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const
type AllowedMime = (typeof ALLOWED_MIME)[number]
function isAllowedMime(s: string): s is AllowedMime {
  return (ALLOWED_MIME as readonly string[]).includes(s)
}

const STATUS_TONE: Record<Status, string> = {
  draft: 'bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200',
  sent: 'bg-blue-50 text-blue-800 ring-1 ring-blue-200',
  paid: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  overdue: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  void: 'bg-red-50 text-red-700 ring-1 ring-red-200',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatMoney(amountMinor: number | null, currency: string): string {
  if (amountMinor == null) return ''
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
    }).format(amountMinor / 100)
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`
  }
}

function formatDate(d: Date | string | null): string {
  if (!d) return ''
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(d))
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length))),
    )
  }
  return btoa(binary)
}

function ownerInput(t: InvoiceTarget): {
  businessAccountId?: string
  contactId?: string
  familyId?: string
} {
  if (t.kind === 'businessAccount') return { businessAccountId: t.businessAccountId }
  if (t.kind === 'contact') return { contactId: t.contactId }
  return { familyId: t.familyId }
}

export function InvoicesPanel({ target }: { target: InvoiceTarget }) {
  const router = useRouter()
  const owner = ownerInput(target)
  const listQuery = trpc.uploadedInvoice.list.useQuery({
    ...owner,
    includeArchived: false,
  })
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const rows = listQuery.data ?? []

  // Totals — derived so the panel is useful at a glance.
  const totalOutstanding = rows
    .filter((r) => r.status === 'sent' || r.status === 'overdue')
    .reduce((sum, r) => sum + (r.amountMinor ?? 0), 0)
  const totalPaid = rows
    .filter((r) => r.status === 'paid')
    .reduce((sum, r) => sum + (r.amountMinor ?? 0), 0)
  const currency = rows[0]?.currency ?? 'GBP'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-3 text-xs text-neutral-600">
          {totalOutstanding > 0 && (
            <span>
              Outstanding:{' '}
              <strong className="text-neutral-900">
                {formatMoney(totalOutstanding, currency)}
              </strong>
            </span>
          )}
          {totalPaid > 0 && (
            <span>
              Paid:{' '}
              <strong className="text-neutral-900">
                {formatMoney(totalPaid, currency)}
              </strong>
            </span>
          )}
        </div>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            Upload invoice
          </Button>
        )}
      </div>

      {creating && (
        <InvoiceUploadForm
          target={target}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            await listQuery.refetch()
            router.refresh()
          }}
        />
      )}

      {listQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No invoices uploaded yet. Click <em>Upload invoice</em> to attach the
          first PDF.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) =>
            editingId === r.id ? (
              <li key={r.id}>
                <InvoiceMetaEditor
                  invoice={r}
                  onClose={() => setEditingId(null)}
                  onSaved={async () => {
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ) : (
              <li
                key={r.id}
                className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm shadow-card"
              >
                <InvoiceRow
                  invoice={r}
                  onEdit={() => setEditingId(r.id)}
                  onChanged={async () => {
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

interface InvoiceRow {
  id: string
  invoiceNumber: string | null
  amountMinor: number | null
  currency: string
  issuedAt: Date | string | null
  dueAt: Date | string | null
  status: Status
  notes: string | null
  fileName: string
  contentType: string
  byteSize: number
  createdAt: Date | string
}

function InvoiceRow({
  invoice,
  onEdit,
  onChanged,
}: {
  invoice: InvoiceRow
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const archive = trpc.uploadedInvoice.archive.useMutation()
  const del = trpc.uploadedInvoice.delete.useMutation()
  const [busy, setBusy] = useState(false)

  async function onArchive() {
    setBusy(true)
    try {
      await archive.mutateAsync({ id: invoice.id })
      toast.success('Invoice archived')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not archive')
    } finally {
      setBusy(false)
    }
  }

  async function onDelete() {
    if (!confirm(`Delete "${invoice.fileName}"? This cannot be undone.`)) return
    setBusy(true)
    try {
      await del.mutateAsync({ id: invoice.id })
      toast.success('Invoice deleted')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[invoice.status]}`}
          >
            {invoice.status}
          </span>
          {invoice.invoiceNumber && (
            <span className="text-sm font-medium text-neutral-900">
              #{invoice.invoiceNumber}
            </span>
          )}
          {invoice.amountMinor != null && (
            <span className="font-mono text-sm text-neutral-800">
              {formatMoney(invoice.amountMinor, invoice.currency)}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
          <a
            href={`/api/uploaded-invoices/${invoice.id}/file`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-700 hover:underline"
          >
            {invoice.fileName}
          </a>
          <span>{formatBytes(invoice.byteSize)}</span>
          {invoice.issuedAt && <span>Issued {formatDate(invoice.issuedAt)}</span>}
          {invoice.dueAt && <span>Due {formatDate(invoice.dueAt)}</span>}
        </div>
        {invoice.notes && (
          <p className="mt-1 text-xs text-neutral-600">{invoice.notes}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="text-xs text-neutral-700 hover:underline"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onArchive}
          disabled={busy}
          className="text-xs text-neutral-600 hover:underline"
        >
          Archive
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-xs text-neutral-600 hover:text-red-700 hover:underline"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

function InvoiceUploadForm({
  target,
  onClose,
  onCreated,
}: {
  target: InvoiceTarget
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('GBP')
  const [status, setStatus] = useState<Status>('sent')
  const [issuedAt, setIssuedAt] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  const create = trpc.uploadedInvoice.create.useMutation()

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setFile(f)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) {
      toast.error('Pick a file first.')
      return
    }
    if (!isAllowedMime(file.type)) {
      toast.error('File type not supported. Use PDF, image, or Excel.')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error('File must be 8 MB or smaller.')
      return
    }
    setBusy(true)
    try {
      const dataBase64 = await fileToBase64(file)
      await create.mutateAsync({
        ...ownerInput(target),
        fileName: file.name,
        contentType: file.type,
        dataBase64,
        invoiceNumber: invoiceNumber.trim() || undefined,
        amountMinor: amount.trim() ? Math.round(parseFloat(amount) * 100) : undefined,
        currency,
        status,
        issuedAt: issuedAt ? new Date(issuedAt) : undefined,
        dueAt: dueAt ? new Date(dueAt) : undefined,
        notes: notes.trim() || undefined,
      })
      toast.success('Invoice uploaded')
      onClose()
      await onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">Upload invoice</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>

      <div>
        <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          File (PDF, image, Excel — max 8 MB)
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.png,.jpg,.jpeg,.webp,.heic,.xls,.xlsx"
          onChange={onPickFile}
          className="mt-1 block w-full text-sm"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Invoice number">
          <Input
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            placeholder="e.g. SM-2026-0042"
          />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="paid">Paid</option>
            <option value="overdue">Overdue</option>
            <option value="void">Void</option>
          </Select>
        </Field>
        <Field label="Amount">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Field label="Currency">
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            placeholder="GBP"
          />
        </Field>
        <Field label="Issued at">
          <Input
            type="date"
            value={issuedAt}
            onChange={(e) => setIssuedAt(e.target.value)}
          />
        </Field>
        <Field label="Due at">
          <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
      </div>

      <Field label="Notes (optional)">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" disabled={busy || !file}>
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function InvoiceMetaEditor({
  invoice,
  onClose,
  onSaved,
}: {
  invoice: InvoiceRow
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoiceNumber ?? '')
  const [amount, setAmount] = useState(
    invoice.amountMinor != null ? (invoice.amountMinor / 100).toFixed(2) : '',
  )
  const [currency, setCurrency] = useState(invoice.currency)
  const [status, setStatus] = useState<Status>(invoice.status)
  const [issuedAt, setIssuedAt] = useState(
    invoice.issuedAt ? new Date(invoice.issuedAt).toISOString().slice(0, 10) : '',
  )
  const [dueAt, setDueAt] = useState(
    invoice.dueAt ? new Date(invoice.dueAt).toISOString().slice(0, 10) : '',
  )
  const [notes, setNotes] = useState(invoice.notes ?? '')
  const [busy, setBusy] = useState(false)

  const update = trpc.uploadedInvoice.update.useMutation()

  async function save() {
    setBusy(true)
    try {
      await update.mutateAsync({
        id: invoice.id,
        invoiceNumber: invoiceNumber.trim() || null,
        amountMinor: amount.trim() ? Math.round(parseFloat(amount) * 100) : null,
        currency,
        status,
        issuedAt: issuedAt ? new Date(issuedAt) : null,
        dueAt: dueAt ? new Date(dueAt) : null,
        notes: notes.trim() || null,
      })
      toast.success('Saved')
      onClose()
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          Edit invoice ({invoice.fileName})
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Invoice number">
          <Input
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
          />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="paid">Paid</option>
            <option value="overdue">Overdue</option>
            <option value="void">Void</option>
          </Select>
        </Field>
        <Field label="Amount">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Currency">
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
          />
        </Field>
        <Field label="Issued at">
          <Input
            type="date"
            value={issuedAt}
            onChange={(e) => setIssuedAt(e.target.value)}
          />
        </Field>
        <Field label="Due at">
          <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
