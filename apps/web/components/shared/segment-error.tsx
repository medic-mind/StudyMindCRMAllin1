// Shared error UI for App Router segments. CLAUDE.md §26 — never expose
// raw error messages; always include a request_id for support.

'use client'

import { useEffect } from 'react'

import { Button } from '@/components/ui/button'

export interface SegmentErrorProps {
  error: Error & { digest?: string }
  reset: () => void
  /** Friendly title shown to the agent. */
  title?: string
}

export function SegmentError({ error, reset, title = 'Something went wrong' }: SegmentErrorProps) {
  useEffect(() => {
    // Surface to Sentry where available; never console.error in prod paths.
    const sentry = (globalThis as unknown as {
      Sentry?: { captureException: (e: unknown) => void }
    }).Sentry
    sentry?.captureException(error)
  }, [error])

  // The digest is the only error identifier we surface. Never the message.
  const requestId = error.digest ?? 'unavailable'

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
      <div className="mt-4">
        <Button onClick={() => reset()} variant="secondary" size="sm">
          Retry
        </Button>
      </div>
    </div>
  )
}
