// User avatar menu — client island. Shows initials in a circle, with a
// dropdown of Profile, role pill, and Sign out. CLAUDE.md §26 (client
// leaves), §28 (Esc closes, restores focus, keyboard reachable).

'use client'

import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { useEffect, useRef, useState } from 'react'

import { ChevronDownIcon, LogOutIcon, UserCircleIcon } from '@/components/ui/icon'
import { formatRoleLabel } from '@/lib/format/role-label'

interface Props {
  email: string
  name: string | null
  role: string
}

function initialsOf(email: string, name: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    const first = parts[0]?.[0] ?? ''
    const last = parts.length > 1 ? parts[parts.length - 1]![0] : ''
    const out = (first + last).toUpperCase()
    if (out) return out
  }
  return email.slice(0, 2).toUpperCase()
}

export function UserMenu({ email, name, role }: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const initials = initialsOf(email, name)

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-full pr-2 text-neutral-700 hover:text-neutral-900"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary-600 text-xs font-semibold text-white"
        >
          {initials}
        </span>
        <ChevronDownIcon size={14} className="text-neutral-500" />
        <span className="sr-only">Open user menu for {email}</span>
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="menu"
          aria-label="User menu"
          className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg"
        >
          <div className="border-b border-neutral-100 px-3 py-3">
            <p className="truncate text-sm font-medium text-neutral-900">
              {name ?? email}
            </p>
            <p className="truncate text-xs text-neutral-500">{email}</p>
            <span className="mt-2 inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700">
              {formatRoleLabel(role)}
            </span>
          </div>
          <ul className="py-1 text-sm">
            <li>
              <Link
                href="/account"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-neutral-700 hover:bg-neutral-50"
              >
                <UserCircleIcon size={16} className="text-neutral-500" />
                Profile
              </Link>
            </li>
            <li>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false)
                  signOut({ callbackUrl: '/sign-in' })
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-neutral-700 hover:bg-neutral-50"
              >
                <LogOutIcon size={16} className="text-neutral-500" />
                Sign out
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  )
}
