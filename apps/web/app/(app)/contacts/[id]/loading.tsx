// Skeleton sized to the comprehensive customer view (ADR 0017) so the layout
// does not shift when the channel data streams in.

export default function Loading(): JSX.Element {
  return (
    <div className="max-w-4xl animate-pulse">
      <div className="h-7 w-64 rounded bg-neutral-200" />
      <div className="mt-2 h-4 w-80 rounded bg-neutral-100" />
      <div className="mt-4 h-12 rounded-md bg-neutral-100" />
      <div className="mt-4 h-9 rounded-md bg-neutral-100" />
      <div className="mt-4 flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 flex-1 rounded-md bg-neutral-100" />
        ))}
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="mt-8 space-y-2">
          <div className="h-6 w-40 rounded bg-neutral-200" />
          <div className="h-16 rounded-md bg-neutral-100" />
          <div className="h-16 rounded-md bg-neutral-100" />
        </div>
      ))}
    </div>
  )
}
