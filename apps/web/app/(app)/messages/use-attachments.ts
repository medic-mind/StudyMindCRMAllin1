// Composer attachment state + upload (ADR 0022 — richer messages). Holds the
// list of pending attachments (uploading → ready/error), uploads each file to
// the staging route, and reads image dimensions client-side so the message
// renders without layout shift. The composer passes the `ready` items'
// metadata to `chat.send`.

'use client'

import { useCallback, useState } from 'react'

import type { StagedAttachmentInput } from '@studymind/core/chat'

const MAX_BYTES = 20 * 1024 * 1024
const MAX_FILES = 10
const UPLOAD_URL = '/api/internal/chat-attachments/upload'

export interface PendingAttachment {
  localId: string
  filename: string
  contentType: string
  sizeBytes: number
  status: 'uploading' | 'ready' | 'error'
  error?: string
  /** Object URL for an instant local image preview while uploading. */
  previewUrl?: string
  width?: number
  height?: number
  /** Server-returned staged metadata, present once status === 'ready'. */
  staged?: StagedAttachmentInput
}

interface UploadResponse {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  s3Key: string
}

function localId(): string {
  return `att_${Math.random().toString(36).slice(2)}_${Date.now()}`
}

/** Read pixel dimensions for an image File; resolves null for non-images. */
function readImageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith('image/')) return Promise.resolve(null)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      resolve(null)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

export interface UseAttachments {
  attachments: PendingAttachment[]
  uploading: boolean
  /** True when every attachment is ready (or there are none). */
  allReady: boolean
  addFiles: (files: FileList | File[]) => void
  remove: (localId: string) => void
  clear: () => void
  /** Metadata for the ready attachments, for chat.send. */
  readyStaged: () => StagedAttachmentInput[]
}

export function useAttachments(): UseAttachments {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])

  const update = useCallback((id: string, patch: Partial<PendingAttachment>) => {
    setAttachments((prev) =>
      prev.map((a) => (a.localId === id ? { ...a, ...patch } : a)),
    )
  }, [])

  const uploadOne = useCallback(
    async (file: File, id: string) => {
      try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch(UPLOAD_URL, { method: 'POST', body: form })
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null
          update(id, { status: 'error', error: data?.error ?? 'Upload failed' })
          return
        }
        const data = (await res.json()) as UploadResponse
        const dims = await readImageSize(file)
        update(id, {
          status: 'ready',
          width: dims?.width,
          height: dims?.height,
          staged: {
            id: data.id,
            filename: data.filename,
            contentType: data.contentType,
            sizeBytes: data.sizeBytes,
            s3Key: data.s3Key,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
          },
        })
      } catch {
        update(id, { status: 'error', error: 'Upload failed' })
      }
    },
    [update],
  )

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      setAttachments((prev) => {
        const room = MAX_FILES - prev.length
        const accepted = list.slice(0, Math.max(0, room))
        const next: PendingAttachment[] = accepted.map((file) => {
          const id = localId()
          const tooBig = file.size > MAX_BYTES
          const isImage = file.type.startsWith('image/')
          const pending: PendingAttachment = {
            localId: id,
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            status: tooBig ? 'error' : 'uploading',
            error: tooBig ? 'Larger than 20 MB' : undefined,
            previewUrl: isImage && !tooBig ? URL.createObjectURL(file) : undefined,
          }
          if (!tooBig) void uploadOne(file, id)
          return pending
        })
        return [...prev, ...next]
      })
    },
    [uploadOne],
  )

  const remove = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((a) => a.localId !== id)
    })
  }, [])

  const clear = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      return []
    })
  }, [])

  const readyStaged = useCallback(
    () =>
      attachments
        .filter((a) => a.status === 'ready' && a.staged)
        .map((a) => a.staged!),
    [attachments],
  )

  return {
    attachments,
    uploading: attachments.some((a) => a.status === 'uploading'),
    allReady: attachments.every((a) => a.status !== 'uploading'),
    addFiles,
    remove,
    clear,
    readyStaged,
  }
}
