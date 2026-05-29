// User avatar menu — client island. Identity at the top, then account links
// (Profile / Password / Sessions / 2FA / Trengo) and Sign out. Account no
// longer needs a sidebar section. CLAUDE.md §26 (client leaves), §28 (Esc
// closes, restores focus, keyboard reachable).

'use client'

import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { useEffect, useRef, useState } from 'react'

import {
  ChevronDownIcon,
  LogOutIcon,
  MailIcon,
  PhoneIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
  UserCircleIcon,
} from '@/components/ui/icon'
import { formatRoleLabel } from '@/lib/format/role-label'

interface Props {
  email: string
  name: string | null
  role: string
  totpEnabled?: boolean
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

export function UserMenu({ email, name, role, totpEnabled = false }: Props) {
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
  const twoFaHref = totpEnabled ? '/account/disable-2fa' : '/account/setup-2fa'

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
          className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg"
        >
          {/* Identity */}
          <div className="border-b border-neutral-100 px-4 py-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary-600 text-sm font-semibold text-white"
              >
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-900">
                  {name ?? email}
                </p>
                <p className="truncate text-xs text-neutral-500">{email}</p>
              </div>
            </div>
            <span className="mt-2 inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700">
              {formatRoleLabel(role)}
            </span>
          </div>

          {/* Account */}
          <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
            Account
          </p>
          <ul className="pb-1 text-sm" role="none">
            <li>
              <Link
                href="/account"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2 text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
              >
                <UserCircleIcon size={15} className="text-neutral-400" />
                Profile
              </Link>
            </li>
            <li>
              <Link
                href="/account/change-password"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2 text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
              >
                <ShieldAlertIcon size={15} className="text-neutral-400" />
                Change password
              </Link>
            </li>
            <li>
              <Link
                href="/account/sessions"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2 text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
              >
                <PhoneIcon size={15} className="text-neutral-400" />
                Sessions
              </Link>
            </li>
            <li>
              <Link
                href={twoFaHref}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between gap-2.5 px-4 py-2 text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
              >
                <span className="flex items-center gap-2.5">
                  <ShieldAlertIcon size={15} className="text-neutral-400" />
                  Two-factor auth
                </span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    totpEnabled
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-amber-50 text-amber-800'
                  }`}
                >
                  {totpEnabled ? 'On' : 'Off'}
                </span>
              </Link>
            </li>
            <li>
              <Link
                href="/account/trengo/connect"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2 text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
              >
                <SmartphoneIcon size={15} className="text-neutral-400" />
                Trengo
              </Link>
            </li>
            <li>
              <Link
                href="/settings/mailbox"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2 text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
              >
                <MailIcon size={15} className="text-neutral-400" />
                Mailboxes
              </Link>
            </li>
          </ul>

          {/* Sign out */}
          <div className="border-t border-neutral-100">
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false)
                signOut({ callbackUrl: '/sign-in' })
              }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
            >
              <LogOutIcon size={15} className="text-neutral-400" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
