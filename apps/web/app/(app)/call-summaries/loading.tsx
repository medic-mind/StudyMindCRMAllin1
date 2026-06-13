// Skeleton sized to the Call Summaries layout (entry form + queue) so the
// navigation paints instantly. CLAUDE.md §26 — no CLS.

export default function Loading() {
  return (
    <div>
      <div
        className="-mx-6 -mt-6 mb-6 flex items-center border-b border-neutral-200 bg-white px-6"
        style={{ minHeight: '80px' }}
      >
        <div className="h-7 w-48 animate-pulse rounded bg-neutral-200" aria-hidden />
      </div>
      <div
        className="h-64 animate-pulse rounded-lg border border-neutral-200 bg-white"
        aria-hidden
      />
      <div
        className="mt-6 h-72 animate-pulse rounded-lg border border-neutral-200 bg-white"
        aria-hidden
      />
      <span className="sr-only">Loading call summaries…</span>
    </div>
  )
}
