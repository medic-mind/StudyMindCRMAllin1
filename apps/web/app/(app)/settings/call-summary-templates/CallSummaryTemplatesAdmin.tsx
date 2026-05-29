// CRUD admin for call summary templates. Inline create + edit, archive +
// restore, PDF attach + remove. Manager+ via the tRPC layer.

'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

interface Template {
  id: string
  name: string
  description: string | null
  body: string
  sortOrder: number
  archived: boolean
  hasPdf: boolean
  pdfFileName: string | null
  pdfByteSize: number | null
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
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

export function CallSummaryTemplatesAdmin() {
  const router = useRouter()
  const listQuery = trpc.callSummaryTemplate.list.useQuery({ includeArchived: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const templates = listQuery.data ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600">
          Templates show as chips on every contact&apos;s <em>Record call summary</em>{' '}
          panel. Pick one, edit the prefill, optionally open the attached PDF as a
          script. Past summaries keep the body they were saved with — editing a
          template only changes future use.
        </p>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            New template
          </Button>
        )}
      </div>

      {creating && (
        <TemplateEditor
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={async () => {
            await listQuery.refetch()
            router.refresh()
          }}
        />
      )}

      {listQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No templates yet. Click <em>New template</em> to add one.
        </p>
      ) : (
        <ul className="space-y-3">
          {templates.map((t) =>
            editingId === t.id ? (
              <li key={t.id}>
                <TemplateEditor
                  mode="edit"
                  template={t}
                  onClose={() => setEditingId(null)}
                  onSaved={async () => {
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ) : (
              <li
                key={t.id}
                className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card"
              >
                <TemplateRow
                  template={t}
                  onEdit={() => setEditingId(t.id)}
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

function TemplateRow({
  template,
  onEdit,
  onChanged,
}: {
  template: Template
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const archive = trpc.callSummaryTemplate.archive.useMutation()
  const restore = trpc.callSummaryTemplate.restore.useMutation()
  const attachPdf = trpc.callSummaryTemplate.attachPdf.useMutation()
  const removePdf = trpc.callSummaryTemplate.removePdf.useMutation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function toggleArchive() {
    setBusy(true)
    try {
      if (template.archived) {
        await restore.mutateAsync({ id: template.id })
        toast.success('Template restored')
      } else {
        await archive.mutateAsync({ id: template.id })
        toast.success('Template archived')
      }
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change')
    } finally {
      setBusy(false)
    }
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files are accepted.')
      return
    }
    setBusy(true)
    try {
      const dataBase64 = await fileToBase64(file)
      await attachPdf.mutateAsync({
        id: template.id,
        fileName: file.name,
        dataBase64,
      })
      toast.success('PDF attached')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function detachPdf() {
    if (!confirm(`Remove "${template.pdfFileName}" from this template?`)) return
    setBusy(true)
    try {
      await removePdf.mutateAsync({ id: template.id })
      toast.success('PDF removed')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">{template.name}</h3>
          {template.archived && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
              Archived
            </span>
          )}
        </div>
        {template.description && (
          <p className="text-xs text-neutral-600">{template.description}</p>
        )}
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs text-neutral-700">
          {template.body}
        </pre>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {template.hasPdf ? (
            <>
              <a
                href={`/api/call-summary-templates/${template.id}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 font-medium text-primary-800 hover:bg-primary-100"
              >
                Open PDF
              </a>
              <span className="text-neutral-500">
                {template.pdfFileName} · {formatBytes(template.pdfByteSize)}
              </span>
              <button
                type="button"
                onClick={detachPdf}
                disabled={busy}
                className="text-neutral-600 hover:text-red-700 hover:underline"
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={onPickFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Attach PDF
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-end">
        <Button type="button" size="sm" variant="secondary" onClick={onEdit}>
          Edit
        </Button>
        <button
          type="button"
          onClick={toggleArchive}
          disabled={busy}
          className="text-xs text-neutral-600 hover:underline"
        >
          {template.archived ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  )
}

function TemplateEditor({
  mode,
  template,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  template?: Template
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [body, setBody] = useState(
    template?.body ??
      'Discussed [topic] with the parent / student.\n\nKey points covered:\n- \n- \n\nAgreed next steps:\n- ',
  )
  const [sortOrder, setSortOrder] = useState(template?.sortOrder ?? 100)
  const [busy, setBusy] = useState(false)

  const create = trpc.callSummaryTemplate.create.useMutation()
  const update = trpc.callSummaryTemplate.update.useMutation()

  async function save() {
    if (!name.trim() || !body.trim()) {
      toast.error('Name and body are required.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'create') {
        await create.mutateAsync({
          name: name.trim(),
          description: description.trim() || undefined,
          body: body.trim(),
          sortOrder,
        })
        toast.success('Template created')
      } else if (template) {
        await update.mutateAsync({
          id: template.id,
          name: name.trim(),
          description: description.trim() || null,
          body: body.trim(),
          sortOrder,
        })
        toast.success('Template updated')
      }
      await onSaved()
      onClose()
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
          {mode === 'create' ? 'New template' : `Edit: ${template?.name}`}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>
      <Field label="Name" htmlFor="cst-name">
        <Input
          id="cst-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. UCAT Call Summary"
        />
      </Field>
      <Field label="Description (optional)" htmlFor="cst-desc">
        <Input
          id="cst-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line hint that shows above the prefill body."
        />
      </Field>
      <Field label="Prefill body" htmlFor="cst-body">
        <Textarea
          id="cst-body"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="font-mono text-sm"
        />
      </Field>
      <Field label="Sort order (lower first)" htmlFor="cst-sort">
        <Input
          id="cst-sort"
          type="number"
          min={0}
          max={10000}
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save template'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
      {mode === 'edit' && (
        <p className="text-[11px] text-neutral-500">
          PDF attachment is managed from the row above after you close this
          editor.
        </p>
      )}
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
