// Desktop (browser) notifications for the bell (ADR 0020 Phase 5 / original
// brief Phase 6 — "Browser notifications"). Client-only: uses the Web
// Notifications API gated behind an explicit opt-in and the browser
// permission prompt. No server state — the preference lives in
// localStorage, the dedupe high-water mark lives there too.
//
// Design notes:
//  - We never auto-request permission; the user clicks "Enable" (a gesture,
//    which the API requires).
//  - On first run we seed the high-water mark to "now" so enabling does not
//    blast a notification for every existing unread row.
//  - We only fire for rows the server already flagged `unread` (actor !==
//    user AND newer than the seen marker), so a user never gets desktop
//    pings for their own actions.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const ENABLED_KEY = 'studymind.browserNotifications.enabled'
const HIGH_WATER_KEY = 'studymind.browserNotifications.highWater'

export interface NotifiableItem {
  id: string
  title: string
  body: string
  occurredAt: Date
  unread: boolean
}

type PermissionState = NotificationPermission | 'unsupported'

function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

function readEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(ENABLED_KEY) === '1'
}

function readHighWater(): number {
  if (typeof window === 'undefined') return Date.now()
  const raw = window.localStorage.getItem(HIGH_WATER_KEY)
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isNaN(parsed) ? Date.now() : parsed
}

function writeHighWater(ts: number): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(HIGH_WATER_KEY, new Date(ts).toISOString())
}

export interface UseBrowserNotifications {
  supported: boolean
  permission: PermissionState
  enabled: boolean
  enable: () => Promise<void>
  disable: () => void
}

/**
 * Fire desktop notifications for newly-arrived unread items. Call with the
 * current notification list each render; the hook diffs against its
 * high-water mark and only pings on genuinely new unread rows.
 */
export function useBrowserNotifications(
  items: NotifiableItem[],
): UseBrowserNotifications {
  const supported = isSupported()
  const [permission, setPermission] = useState<PermissionState>(
    supported ? Notification.permission : 'unsupported',
  )
  const [enabled, setEnabled] = useState<boolean>(false)
  // Seed the high-water mark once so we don't fire for the backlog. Lives in
  // a ref so the firing effect doesn't re-run when it advances.
  const highWaterRef = useRef<number>(0)
  const seeded = useRef(false)

  useEffect(() => {
    if (!supported) return
    setEnabled(readEnabled())
    highWaterRef.current = readHighWater()
    seeded.current = true
  }, [supported])

  const enable = useCallback(async () => {
    if (!supported) return
    const result = await Notification.requestPermission()
    setPermission(result)
    if (result === 'granted') {
      window.localStorage.setItem(ENABLED_KEY, '1')
      // Reset the high-water mark to now so we start pinging from here.
      highWaterRef.current = Date.now()
      writeHighWater(highWaterRef.current)
      setEnabled(true)
    }
  }, [supported])

  const disable = useCallback(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(ENABLED_KEY, '0')
    setEnabled(false)
  }, [])

  useEffect(() => {
    if (!supported || !enabled || permission !== 'granted') return
    if (!seeded.current) return
    if (items.length === 0) return

    const highWater = highWaterRef.current
    const fresh = items
      .filter((i) => i.unread && i.occurredAt.getTime() > highWater)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    if (fresh.length === 0) return

    // Advance the high-water mark to the newest fresh item up-front so a
    // re-render (or a second tab) doesn't double-fire.
    const newest = fresh[fresh.length - 1]!.occurredAt.getTime()
    highWaterRef.current = newest
    writeHighWater(newest)

    try {
      if (fresh.length === 1) {
        const n = fresh[0]!
        new Notification(n.title, { body: n.body, tag: n.id })
      } else {
        // Collapse a burst into a single summary so we don't spam the OS.
        new Notification(`${fresh.length} new updates`, {
          body: fresh
            .slice(-3)
            .map((n) => n.title)
            .join('\n'),
          tag: 'studymind-burst',
        })
      }
    } catch {
      // Some browsers throw if the document is not focused / not allowed.
      // Non-fatal — the in-app bell still shows the count.
    }
  }, [items, supported, enabled, permission])

  return { supported, permission, enabled, enable, disable }
}
