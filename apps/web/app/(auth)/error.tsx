'use client'

// Local error boundary for the (auth) segment. Catches errors thrown
// during render of sign-in, sign-up, /setup, /forgot, /reset, etc. so
// the operator sees something actionable instead of the generic global
// error page. CLAUDE.md §26 (every route segment has error.tsx).

import * as Sentry from '@sentry/nextjs'
import Link from 'next/link'
import { useEffect } from 'react'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

export default function AuthSegmentError({ error, reset }: Props) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">
        Something went wrong
      </h1>
      <p className="mb-4 text-sm text-neutral-600">
        The error has been logged. The message below is shown to help
        diagnose — in production it may be redacted.
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 font-mono text-xs text-red-900">
        {error.message || 'No message'}
        {error.digest ? `\n\ndigest: ${error.digest}` : ''}
      </pre>
      <div className="mt-6 flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-neutral-200 px-3 py-1.5 font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Try again
        </button>
        <Link
          href="/sign-in"
          className="font-medium text-neutral-900 hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
