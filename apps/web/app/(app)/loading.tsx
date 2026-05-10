// Dashboard loading skeleton sized to match the eventual KPI grid + two
// panels. CLAUDE.md §26 (no CLS — skeleton matches final layout).

export default function Loading() {
  return (
    <div>
      <div
        className="-mx-6 -mt-6 mb-6 flex items-center border-b border-neutral-200 bg-white px-6"
        style={{ minHeight: '80px' }}
      >
        <div className="h-7 w-40 animate-pulse rounded bg-neutral-200" aria-hidden />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-lg border border-neutral-200 bg-white"
            aria-hidden
          />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div
          className="h-72 animate-pulse rounded-lg border border-neutral-200 bg-white"
          aria-hidden
        />
        <div
          className="h-72 animate-pulse rounded-lg border border-neutral-200 bg-white"
          aria-hidden
        />
      </div>
      <span className="sr-only">Loading dashboard…</span>
    </div>
  )
}
