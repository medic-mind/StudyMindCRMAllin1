// CRUD admin for the info pack / brochure document library. Inline create +
// edit, replace PDF, archive + restore + permanent delete. Manager+ via the
// tRPC layer.

'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

interface InfoPack {
  id: string
  name: string
  description: string | null
  sortOrder: number
  fileName: string
  byteSize: number
  archived: boolean
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

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

export function InfoPacksAdmin() {
  const router = useRouter()
  const listQuery = trpc.infoPack.list.useQuery({ includeArchived: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const packs = listQuery.data ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600">
          These PDFs appear in the call-summary email step as one-click attachments. Keep
          names recognisable mid-call (e.g. <em>UCAT Information Pack</em>,{' '}
          <em>A-Level Tutoring Brochure</em>).
        </p>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            New document
          </Button>
        )}
      </div>

      {creating && (
        <InfoPackEditor
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
      ) : packs.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No documents yet — click <em>New document</em> to upload your first information
          pack or brochure.
        </p>
      ) : (
        <ul className="space-y-3">
          {packs.map((p) =>
            editingId === p.id ? (
              <li key={p.id}>
                <InfoPackEditor
                  mode="edit"
                  pack={p}
                  onClose={() => setEditingId(null)}
                  onSaved={async () => {
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ) : (
              <li
                key={p.id}
                className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card"
              >
                <InfoPackRow
                  pack={p}
                  onEdit={() => setEditingId(p.id)}
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

function InfoPackRow({
  pack,
  onEdit,
  onChanged,
}: {
  pack: InfoPack
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const archive = trpc.infoPack.archive.useMutation()
  const restore = trpc.infoPack.restore.useMutation()
  const replaceFile = trpc.infoPack.replaceFile.useMutation()
  const remove = trpc.infoPack.delete.useMutation()
  const confirm = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function toggleArchive() {
    setBusy(true)
    try {
      if (pack.archived) {
        await restore.mutateAsync({ id: pack.id })
        toast.success('Document restored')
      } else {
        await archive.mutateAsync({ id: pack.id })
        toast.success('Document archived')
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
    if (!isPdf(file)) {
      toast.error('Only PDF files are accepted.')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error(`"${file.name}" is over the 8 MB limit.`)
      return
    }
    setBusy(true)
    try {
      const dataBase64 = await fileToBase64(file)
      await replaceFile.mutateAsync({ id: pack.id, fileName: file.name, dataBase64 })
      toast.success('PDF replaced')
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function deleteForever() {
    if (
      !(await confirm({
        title: `Delete "${pack.name}"?`,
        body: 'The document and its PDF are removed permanently. Sent emails keep their copies.',
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    try {
      await remove.mutateAsync({ id: pack.id })
      toast.success('Document deleted')
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">{pack.name}</h3>
          {pack.archived && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
              Archived
            </span>
          )}
        </div>
        {pack.description && <p className="text-xs text-neutral-600">{pack.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <a
            href={`/api/info-packs/${pack.id}/file`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 font-medium text-primary-800 hover:bg-primary-100"
          >
            Open PDF
          </a>
          <span className="text-neutral-500">
            {pack.fileName} · {formatBytes(pack.byteSize)}
          </span>
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
            className="text-neutral-600 hover:underline"
          >
            Replace PDF
          </button>
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
          {pack.archived ? 'Restore' : 'Archive'}
        </button>
        {pack.archived && (
          <button
            type="button"
            onClick={deleteForever}
            disabled={busy}
            className="text-xs text-red-700 hover:underline"
          >
            Delete forever
          </button>
        )}
      </div>
    </div>
  )
}

function InfoPackEditor({
  mode,
  pack,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  pack?: InfoPack
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(pack?.name ?? '')
  const [description, setDescription] = useState(pack?.description ?? '')
  const [sortOrder, setSortOrder] = useState(pack?.sortOrder ?? 100)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const create = trpc.infoPack.create.useMutation()
  const update = trpc.infoPack.update.useMutation()

  async function save() {
    if (!name.trim()) {
      toast.error('Name is required.')
      return
    }
    if (mode === 'create' && !file) {
      toast.error('Pick the PDF to upload.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'create' && file) {
        const dataBase64 = await fileToBase64(file)
        await create.mutateAsync({
          name: name.trim(),
          description: description.trim() || undefined,
          sortOrder,
          fileName: file.name,
          dataBase64,
        })
        toast.success('Document added')
      } else if (pack) {
        await update.mutateAsync({
          id: pack.id,
          name: name.trim(),
          description: description.trim() || null,
          sortOrder,
        })
        toast.success('Document updated')
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
          {mode === 'create' ? 'New document' : `Edit: ${pack?.name}`}
        </h3>
        <button type="button" onClick={onClose} className="text-xs text-neutral-500 hover:underline">
          Close
        </button>
      </div>
      <Field label="Name" htmlFor="ip-name">
        <Input
          id="ip-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. UCAT Information Pack"
        />
      </Field>
      <Field label="Description (optional)" htmlFor="ip-desc">
        <Input
          id="ip-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line hint shown in the attachment picker."
        />
      </Field>
      {mode === 'create' && (
        <Field label="PDF file (max 8 MB)" htmlFor="ip-file">
          <input
            id="ip-file"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              if (f && !isPdf(f)) {
                toast.error('Only PDF files are accepted.')
                e.target.value = ''
                return
              }
              if (f && f.size > 8 * 1024 * 1024) {
                toast.error(`"${f.name}" is over the 8 MB limit.`)
                e.target.value = ''
                return
              }
              setFile(f)
            }}
            className="block w-full text-sm text-neutral-700 file:mr-3 file:rounded-md file:border file:border-neutral-200 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-neutral-700 hover:file:bg-neutral-50"
          />
        </Field>
      )}
      <Field label="Sort order (lower first)" htmlFor="ip-sort">
        <Input
          id="ip-sort"
          type="number"
          min={0}
          max={10000}
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Upload document' : 'Save changes'}
        </Button>
        <button type="button" onClick={onClose} className="text-sm text-neutral-600 hover:underline">
          Cancel
        </button>
      </div>
      {mode === 'edit' && (
        <p className="text-[11px] text-neutral-500">
          The PDF itself is replaced from the row above after you close this editor.
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
