// Skeleton for the messaging workspace, sized to the eventual layout to avoid
// CLS (CLAUDE.md §26).

export default function MessagesLoading() {
  return (
    <div className="-mx-6 -my-6 flex h-[calc(100vh-var(--shell-topbar-height))] overflow-hidden">
      <div className="w-60 shrink-0 space-y-2 border-r border-neutral-200 bg-neutral-50/70 p-3">
        <div className="h-6 w-28 animate-pulse rounded bg-neutral-200" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-7 w-full animate-pulse rounded bg-neutral-100" />
        ))}
      </div>
      <div className="flex flex-1 flex-col">
        <div className="h-14 border-b border-neutral-200 bg-white" />
        <div className="flex-1 space-y-4 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-neutral-200" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-32 animate-pulse rounded bg-neutral-200" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
