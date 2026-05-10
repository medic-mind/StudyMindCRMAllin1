// Shared loading skeleton for App Router segments. CLAUDE.md §26 —
// skeletons sized to the layout to prevent CLS.

export interface SegmentLoadingProps {
  /** Number of skeleton rows to render. */
  rows?: number
  /** Optional heading shown above the rows. */
  title?: string
}

export function SegmentLoading({ rows = 6, title }: SegmentLoadingProps) {
  return (
    <div>
      {title ? (
        <div className="h-7 w-48 animate-pulse rounded bg-neutral-200" aria-hidden />
      ) : null}
      <div className="mt-6 space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded border border-neutral-200 bg-neutral-50"
            aria-hidden
          />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  )
}
