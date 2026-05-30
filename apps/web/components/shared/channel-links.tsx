// Compact, reusable click-to-contact controls for dense list tables
// (Contacts, Accounts). CLAUDE.md §10 (Aircall click-to-call + Google Voice
// fallback), §14 (email).
//
// `EmailLink` is a plain `mailto:` — the OS / Gmail picks it up. `PhoneLink`
// opens a tiny menu offering Aircall (tel:, intercepted by the Aircall Phone
// app when installed) or Google Voice (web dialler in a new tab). Unlike the
// heavier CallButton on the contact page, these do NOT log an Interaction —
// they're scan-and-dial affordances inside a list, not a committed call.

'use client'

import { useEffect, useRef, useState } from 'react'

import { ChevronDownIcon, MailIcon, PhoneIcon } from '@/components/ui/icon'

function looksUK(phone: string): boolean {
  return phone.startsWith('+44')
}

function googleVoiceUrl(phone: string): string {
  return `https://voice.google.com/u/0/calls?a=nc,${encodeURIComponent(phone)}`
}

export function EmailLink({
  email,
  className,
}: {
  email: string | null | undefined
  className?: string
}) {
  if (!email) return <span className="text-neutral-300">—</span>
  return (
    <a
      href={`mailto:${email}`}
      onClick={(e) => e.stopPropagation()}
      className={
        className ??
        'inline-flex max-w-[18rem] items-center gap-1 truncate text-neutral-700 hover:text-primary-700 hover:underline'
      }
      title={`Email ${email}`}
    >
      <MailIcon size={12} className="shrink-0 text-neutral-400" />
      <span className="truncate">{email}</span>
    </a>
  )
}

export function PhoneLink({ phone }: { phone: string | null | undefined }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

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

  if (!phone) return <span className="text-neutral-300">—</span>

  return (
    <span className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 font-mono text-neutral-700 hover:text-primary-700 hover:underline"
        title={`Call ${phone}`}
      >
        <PhoneIcon size={12} className="shrink-0 text-neutral-400" />
        <span>{phone}</span>
        <ChevronDownIcon size={10} className="text-neutral-400" />
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Call options"
          className="absolute left-0 z-50 mt-1 w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white text-left shadow-lg"
        >
          <a
            role="menuitem"
            href={`tel:${phone}`}
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-xs transition-colors hover:bg-neutral-50"
          >
            <span className="font-medium text-neutral-900">Aircall</span>
            <span className="ml-1 text-neutral-500">
              {looksUK(phone) ? '· recommended for UK' : '· tel:'}
            </span>
          </a>
          <a
            role="menuitem"
            href={googleVoiceUrl(phone)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="block border-t border-neutral-100 px-3 py-2 text-xs transition-colors hover:bg-neutral-50"
          >
            <span className="font-medium text-neutral-900">Google Voice</span>
            <span className="ml-1 text-neutral-500">
              {!looksUK(phone) ? '· recommended' : '· new tab'}
            </span>
          </a>
        </div>
      ) : null}
    </span>
  )
}
