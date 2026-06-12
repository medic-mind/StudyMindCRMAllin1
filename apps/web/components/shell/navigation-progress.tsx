// Global navigation feedback (CLAUDE.md §26/§28). App Router gives NO visual
// response between clicking a link and the server streaming the next page —
// on a dynamic CRM that gap reads as "the button didn't work", so agents
// click again. This slim top bar starts the moment an internal link is
// clicked (capture phase, so it beats Next's router) and completes when the
// URL actually changes. Dependency-free; honours reduced motion by being a
// plain opacity/width fade under 200ms-equivalent perception.

'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

function ProgressBarInner() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [phase, setPhase] = useState<'idle' | 'active' | 'done'>('idle')
  const [width, setWidth] = useState(0)
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const start = useCallback(() => {
    if (phaseRef.current === 'active') return
    if (doneTimer.current) clearTimeout(doneTimer.current)
    setPhase('active')
    setWidth(0)
    // Two frames so the 0-width paint lands before the long transition kicks
    // in — otherwise the bar appears already at 85%.
    requestAnimationFrame(() => requestAnimationFrame(() => setWidth(85)))
    if (safetyTimer.current) clearTimeout(safetyTimer.current)
    // A navigation that somehow never lands (aborted, same-URL replace)
    // must not leave a stuck bar.
    safetyTimer.current = setTimeout(() => setPhase('idle'), 20_000)
  }, [])

  // The URL changed — the new page is committed. Snap to 100% and fade.
  useEffect(() => {
    if (phaseRef.current !== 'active') return
    if (safetyTimer.current) clearTimeout(safetyTimer.current)
    setWidth(100)
    setPhase('done')
    doneTimer.current = setTimeout(() => {
      setPhase('idle')
      setWidth(0)
    }, 250)
    // Deps are deliberately just the URL — this effect must fire on route
    // change only (phase is read through the ref).
  }, [pathname, searchParams])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const target = e.target as Element | null
      const anchor = target?.closest?.('a')
      if (!anchor) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#')) return
      let url: URL
      try {
        url = new URL(href, window.location.href)
      } catch {
        return
      }
      if (url.origin !== window.location.origin) return
      // File-serving endpoints open inline/new — not a page navigation.
      if (url.pathname.startsWith('/api/')) return
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return
      }
      start()
    }
    function onPopState() {
      start()
    }
    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPopState)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('popstate', onPopState)
      if (safetyTimer.current) clearTimeout(safetyTimer.current)
      if (doneTimer.current) clearTimeout(doneTimer.current)
    }
  }, [start])

  if (phase === 'idle') return null

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[9999] h-0.5"
    >
      <div
        className={
          phase === 'done'
            ? 'h-full bg-primary-600 opacity-0 transition-[width,opacity] duration-200 ease-out'
            : 'h-full bg-primary-600 transition-[width] duration-[8000ms] ease-out'
        }
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

/** useSearchParams needs a Suspense boundary; the bar renders nothing while
 *  suspended so the fallback is just null. */
export function NavigationProgress() {
  return (
    <Suspense fallback={null}>
      <ProgressBarInner />
    </Suspense>
  )
}
