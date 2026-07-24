// "Export CSV" button. Wraps `downloadCsv` so list pages can drop in a
// single component instead of wiring the click handler each time.
// Renders a quiet outline button that matches the action-link style used
// elsewhere in the shell.

'use client'

import { useState } from 'react'

import { downloadCsv, type CsvColumn } from '@/lib/csv'

interface Props<T> {
  /** Click handler returns the rows to export. Lets the caller refetch /
   * paginate-all before handing rows over so the CSV captures the full
   * dataset, not just the current page. */
  getRows: () => Promise<readonly T[]> | readonly T[]
  columns: readonly CsvColumn<T>[]
  fileNameBase: string
  label?: string
  disabled?: boolean
  className?: string
  /** Fired after a successful export with the row count, so the caller can
   * record the export in the audit log (CLAUDE.md §20 — bulk exports are
   * tracked). Kept generic so this component stays tRPC-free. */
  onExported?: (rowCount: number) => void
}

const BTN_CLS =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-800 shadow-card transition-colors hover:border-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60'

export function CsvExportButton<T>({
  getRows,
  columns,
  fileNameBase,
  label = 'Export CSV',
  disabled,
  className,
  onExported,
}: Props<T>) {
  const [busy, setBusy] = useState(false)
  async function onClick() {
    setBusy(true)
    try {
      const rows = await getRows()
      downloadCsv(fileNameBase, rows, columns)
      onExported?.(rows.length)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={className ?? BTN_CLS}
    >
      <DownloadGlyph />
      {busy ? 'Exporting…' : label}
    </button>
  )
}

function DownloadGlyph() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}
