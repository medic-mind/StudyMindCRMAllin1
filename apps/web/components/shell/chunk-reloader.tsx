// Recover from stale-JS-chunk failures after a deploy.
//
// When a new version ships, a browser that still holds the OLD page requests
// chunk files whose hashes no longer exist on the server. The lazy import 404s,
// and an App-Router navigation can hang on a blank / perpetually-loading screen
// (the "nothing loads after login, keeps loading, some people" symptom). The
// route error boundary's `reset()` doesn't help — it re-attempts the same
// missing chunk. The only real recovery is a FULL reload, which fetches the
// fresh HTML + the current chunk references.
//
// This mounts in the root layout (so it's live before any route chunk loads),
// listens for chunk-load failures, and forces ONE reload — hard-capped so it can
// never loop into a reload storm.

'use client'

import { useEffect } from 'react'

const CHUNK_ERROR =
  /ChunkLoadError|Loading chunk [\w./-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading CSS chunk/i

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false
  if (typeof err === 'string') return CHUNK_ERROR.test(err)
  if (typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown }
    if (e.name === 'ChunkLoadError') return true
    if (typeof e.message === 'string' && CHUNK_ERROR.test(e.message)) return true
  }
  return false
}

const GUARD_KEY = 'sm_chunk_reload_count'
const MAX_RELOADS = 2

/** Force a full reload, but at most MAX_RELOADS times per session so a genuinely
 *  broken chunk (that a reload can't fix) can't loop forever. */
export function reloadForStaleChunk(): void {
  try {
    const n = Number(sessionStorage.getItem(GUARD_KEY) ?? '0')
    if (n >= MAX_RELOADS) return // reloading didn't help — let the error surface
    sessionStorage.setItem(GUARD_KEY, String(n + 1))
  } catch {
    /* sessionStorage unavailable — still reload once */
  }
  window.location.reload()
}

export function ChunkReloader() {
  useEffect(() => {
    // We rendered, so this session's chunks are current — clear the budget so a
    // FUTURE deploy's stale chunk gets a fresh reload allowance.
    try {
      sessionStorage.removeItem(GUARD_KEY)
    } catch {
      /* ignore */
    }

    function onError(e: ErrorEvent) {
      if (isChunkLoadError(e.error) || isChunkLoadError(e.message)) reloadForStaleChunk()
    }
    function onRejection(e: PromiseRejectionEvent) {
      if (isChunkLoadError(e.reason)) reloadForStaleChunk()
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
  return null
}
