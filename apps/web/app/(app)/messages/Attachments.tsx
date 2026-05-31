// Renders a message's attachments (ADR 0022 — richer messages). Images show
// inline as bounded thumbnails that open full-size in a new tab; other files
// render as a download chip. Dimensions (when known) reserve layout space to
// avoid shift.

'use client'

import { DownloadIcon, FileIcon } from '@/components/ui/icon'

import type { MessageAttachment } from './types'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function Attachments({ attachments }: { attachments: ReadonlyArray<MessageAttachment> }) {
  if (attachments.length === 0) return null

  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((a) => {
        if (a.isImage) {
          // Bounded thumbnail; preserve aspect ratio when we know dimensions.
          const ratio = a.width && a.height ? a.width / a.height : null
          return (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-300"
              title={a.filename}
            >
              <img
                src={a.url}
                alt={a.filename}
                loading="lazy"
                className="max-h-72 max-w-xs object-cover"
                style={
                  ratio
                    ? { aspectRatio: String(ratio), width: Math.min(a.width ?? 320, 320) }
                    : undefined
                }
              />
            </a>
          )
        }
        return (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            download={a.filename}
            className="group flex items-center gap-2.5 rounded-lg border border-neutral-200 bg-white px-3 py-2 hover:border-primary-300 hover:bg-primary-50/40"
            title={`Download ${a.filename}`}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-neutral-100 text-neutral-500 group-hover:text-primary-600">
              <FileIcon size={18} />
            </span>
            <span className="min-w-0 max-w-[14rem]">
              <span className="block truncate text-sm font-medium text-neutral-800">
                {a.filename}
              </span>
              <span className="block text-[11px] text-neutral-500">
                {formatBytes(a.sizeBytes)}
              </span>
            </span>
            <DownloadIcon
              size={15}
              className="ml-1 shrink-0 text-neutral-400 group-hover:text-primary-600"
            />
          </a>
        )
      })}
    </div>
  )
}
