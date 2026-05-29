// Small files attached to a contact (EHCPs, school letters, intake forms).
// Stored in Postgres so a self-hosted install needs no S3. CLAUDE.md §4.

'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Input } from '@/components/ui/input'
import { FileTextIcon, XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

const ALLOWED_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

const MAX_BYTES = 8 * 1024 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.onload = () => {
      const r = typeof reader.result === 'string' ? reader.result : ''
      const c = r.indexOf(',')
      resolve(c >= 0 ? r.slice(c + 1) : r)
    }
    reader.readAsDataURL(file)
  })
}

interface Props {
  contactId: string
}

export function DocumentsSection({ contactId }: Props) {
  const router = useRouter()
  const docs = trpc.contact.documents.list.useQuery({ contactId })
  const add = trpc.contact.documents.add.useMutation()
  const remove = trpc.contact.documents.remove.useMutation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleFile(file: File | undefined) {
    if (!file) return
    if (!(ALLOWED_TYPES as readonly string[]).includes(file.type)) {
      toast.error('That file type is not supported.')
      return
    }
    if (file.size > MAX_BYTES) {
      toast.error('File must be 8 MB or smaller.')
      return
    }
    setBusy(true)
    try {
      const dataBase64 = await fileToBase64(file)
      await add.mutateAsync({
        contactId,
        fileName: file.name,
        contentType: file.type as (typeof ALLOWED_TYPES)[number],
        description: description.trim() || undefined,
        dataBase64,
      })
      toast.success('Uploaded')
      setDescription('')
      await docs.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleRemove(id: string, fileName: string) {
    if (!confirm(`Remove ${fileName}? This cannot be undone.`)) return
    try {
      await remove.mutateAsync({ id })
      toast.success('Removed')
      await docs.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    }
  }

  const items = docs.data ?? []

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No documents yet. Upload EHCPs, school letters, intake forms — anything that should travel with this contact.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {items.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700">
                <FileTextIcon size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={`/api/contacts/${contactId}/documents/${d.id}`}
                  className="block truncate text-sm font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                >
                  {d.fileName}
                </a>
                <div className="truncate text-xs text-neutral-500">
                  {formatBytes(d.byteSize)} ·{' '}
                  {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                    new Date(d.createdAt),
                  )}
                  {d.description ? ` · ${d.description}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(d.id, d.fileName)}
                className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                aria-label={`Remove ${d.fileName}`}
              >
                <XIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50/60 p-3">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="bg-white"
        />
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_TYPES.join(',')}
          onChange={(e) => void handleFile(e.target.files?.[0])}
          disabled={busy}
          className="block w-full text-sm text-neutral-600 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-primary-700 disabled:opacity-50"
        />
        <p className="text-[11px] text-neutral-500">
          PDF, images, Office docs, plain text. Up to 8&nbsp;MB.
        </p>
      </div>
    </div>
  )
}
