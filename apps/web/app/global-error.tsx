// Top-level error boundary. App Router renders this when an error escapes
// every route segment's error.tsx (i.e. a render-time exception in the
// root layout itself). We forward to Sentry so production debugging is
// possible. CLAUDE.md §25 (observability).

'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

import { isChunkLoadError, reloadForStaleChunk } from '@/components/shell/chunk-reloader'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ error, reset }: Props) {
  useEffect(() => {
    Sentry.captureException(error)
    // A stale-chunk error can't be fixed by reset() (it re-attempts the missing
    // chunk) — force a full reload to pick up the new build.
    if (isChunkLoadError(error)) reloadForStaleChunk()
  }, [error])

  return (
    <html>
      <body>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 32,
            fontFamily: 'system-ui, sans-serif',
            color: '#0f172a',
          }}
        >
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: '#475569' }}>
            We have logged the error. You can try again or sign in if the
            problem persists.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>
              request id: {error.digest}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                border: '1px solid #1d4ed8',
                background: '#1d4ed8',
                color: 'white',
                padding: '6px 12px',
                borderRadius: 6,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                border: '1px solid #cbd5e1',
                background: 'white',
                color: '#0f172a',
                padding: '6px 12px',
                borderRadius: 6,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
