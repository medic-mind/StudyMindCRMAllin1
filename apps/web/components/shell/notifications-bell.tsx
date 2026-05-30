// Notifications bell — client island in the top app bar. Reads
// `trpc.notifications.list` and shows an unread badge count. Opens a
// dropdown panel with the most recent notifications. CLAUDE.md §27
// (TanStack Query via tRPC).

'use client'

import { useEffect, useRef, useState } from 'react'

import { trpc } from '@/lib/trpc/client'

import { BellIcon } from '@/components/ui/icon'

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const min = Math.round(diffMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

const ACTION_LABEL: Record<string, string> = {
  'contact.created': 'Contact created',
  'contact.updated': 'Contact updated',
  'family.state_changed': 'Family state changed',
  'safeguarding.concern_raised': 'Safeguarding concern raised',
  'finance.refund.created': 'Refund issued',
  'finance.payment_link.created': 'Payment link sent',
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const utils = trpc.useUtils()
  const query = trpc.notifications.list.useQuery(
    { limit: 10 },
    { staleTime: 30_000, refetchOnWindowFocus: true },
  )
  const unread = query.data?.unreadCount ?? 0

  // ADR 0020 Phase 5 — persist the seen marker the first time the panel is
  // opened while there are unread rows. Idempotent on the server side; we
  // also refetch the list so the badge clears immediately.
  const markSeen = trpc.notifications.markSeen.useMutation({
    onSuccess: () => {
      void utils.notifications.list.invalidate()
    },
  })
  useEffect(() => {
    if (!open) return
    if (unread === 0) return
    if (markSeen.isPending) return
    markSeen.mutate({})
    // The mutation closure is stable for the lifetime of this effect; we
    // only want to fire on `open` going true while there is something to
    // clear, so listing markSeen in deps is intentional.
  }, [open, unread, markSeen])

  // Click outside / Esc closes the panel.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!panelRef.current || !triggerRef.current) return
      const target = e.target as Node
      if (panelRef.current.contains(target) || triggerRef.current.contains(target)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={
          unread > 0
            ? `Notifications, ${unread} unread`
            : 'Notifications'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      >
        <BellIcon size={18} />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger-600 px-1 text-[10px] font-semibold leading-none text-white"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Recent notifications"
          className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg"
        >
          <div className="border-b border-neutral-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Notifications
          </div>
          <ul className="max-h-80 divide-y divide-neutral-100 overflow-y-auto">
            {query.isLoading ? (
              <li className="px-3 py-4 text-sm text-neutral-500">Loading…</li>
            ) : (query.data?.items.length ?? 0) === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-neutral-500">
                No notifications yet. Updates on your activity will appear
                here.
              </li>
            ) : (
              query.data!.items.map((n) => (
                <li
                  key={n.id}
                  className={
                    n.unread
                      ? 'flex items-start gap-2 bg-primary-50/50 px-3 py-2'
                      : 'flex items-start gap-2 px-3 py-2'
                  }
                >
                  {n.unread ? (
                    <span
                      aria-hidden="true"
                      className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-primary-600"
                    />
                  ) : (
                    <span aria-hidden="true" className="mt-1.5 inline-block h-2 w-2 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-neutral-900">
                      {ACTION_LABEL[n.action] ?? n.action}
                    </p>
                    <p className="truncate text-xs text-neutral-500">
                      {n.targetType} · {formatRelative(n.occurredAt)}
                    </p>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
