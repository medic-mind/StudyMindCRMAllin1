// Shared error UI for App Router segments. CLAUDE.md §26 — never expose
// raw error messages to family-facing surfaces. This is staff-only chrome
// inside the (app) shell, so we surface the error name + first line of
// the message in a collapsed details element. Stack traces are still kept
// out of the DOM (Sentry has them).

'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'

export interface SegmentErrorProps {
  error: Error & { digest?: string }
  reset: () => void
  /** Friendly title shown to the agent. */
  title?: string
}

export function SegmentError({ error, reset, title = 'Something went wrong' }: SegmentErrorProps) {
  const [showDetails, setShowDetails] = useState(false)
  const [autoReloading, setAutoReloading] = useState(false)

  useEffect(() => {
    // Surface to Sentry where available; never console.error in prod paths.
    const sentry = (globalThis as unknown as {
      Sentry?: { captureException: (e: unknown) => void }
    }).Sentry
    sentry?.captureException(error)
  }, [error])

  useEffect(() => {
    // Self-heal once per error: the most common cause of a production RSC
    // render error here is deployment version skew — the click fetched a
    // server payload from a build that was just replaced. A hard reload picks
    // up the new build. Guarded per digest via sessionStorage so a genuinely
    // broken view still shows the panel instead of reload-looping.
    const key = `segment-error-reloaded:${error.digest ?? error.message ?? 'unknown'}`
    try {
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, String(Date.now()))
        setAutoReloading(true)
        window.location.reload()
      }
    } catch {
      // sessionStorage unavailable — leave the manual Retry button.
    }
  }, [error])

  const requestId = error.digest ?? 'unavailable'
  const errorName = error.name || 'Error'
  // Take the first line of the message only — keep multi-line stacks out of the DOM.
  const errorMessage = ((error.message ?? '').split('\n')[0] ?? '').slice(0, 300)

  if (autoReloading) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <p className="text-sm text-neutral-600">Refreshing this view…</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6">
      <h2 className="text-lg font-semibold text-red-900">{title}</h2>
      <p className="mt-2 text-sm text-red-800">
        We hit an error loading this view. The team has been notified. You can
        try again, or contact support and quote the request id below.
      </p>
      <div className="mt-3 font-mono text-xs text-red-900/80">
        request_id: {requestId}
      </div>
      {errorMessage ? (
        <details
          className="mt-3"
          open={showDetails}
          onToggle={(e) => setShowDetails((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-xs text-red-900/80 hover:text-red-900">
            {showDetails ? 'Hide' : 'Show'} technical details
          </summary>
          <div className="mt-2 rounded bg-red-100 p-3 font-mono text-xs text-red-900">
            <div className="font-semibold">{errorName}</div>
            <div className="mt-1 break-words">{errorMessage}</div>
          </div>
        </details>
      ) : null}
      <div className="mt-4">
        <Button onClick={() => reset()} variant="secondary" size="sm">
          Retry
        </Button>
      </div>
    </div>
  )
}
