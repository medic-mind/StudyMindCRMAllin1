// Dashboard loading skeleton sized to match the eventual layout (KPI row +
// "Needs attention" queue grid + two panels + quick links) so there is no CLS.
// CLAUDE.md §26 (skeleton matches final layout), §28.

export default function Loading() {
  return (
    <div>
      <div
        className="-mx-4 -mt-4 mb-6 flex items-center border-b border-neutral-200 bg-white px-4 sm:-mx-6 sm:px-6"
        style={{ minHeight: '72px' }}
      >
        <div className="h-7 w-40 animate-pulse rounded bg-neutral-200" aria-hidden />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-xl border border-neutral-200 bg-white"
            aria-hidden
          />
        ))}
      </div>

      {/* Needs attention queue grid */}
      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-[68px] animate-pulse rounded-xl border border-neutral-200 bg-white"
            aria-hidden
          />
        ))}
      </div>

      {/* Two panels */}
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-72 animate-pulse rounded-lg border border-neutral-200 bg-white" aria-hidden />
        <div className="h-72 animate-pulse rounded-lg border border-neutral-200 bg-white" aria-hidden />
      </div>

      <span className="sr-only">Loading dashboard…</span>
    </div>
  )
}
