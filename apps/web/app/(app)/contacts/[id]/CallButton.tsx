// Click-to-call. CLAUDE.md §10 (Aircall) — plus Google Voice as the fallback
// for non-UK destinations. The actual call is initiated by the OS / Aircall
// Phone app (tel:) or by opening Google Voice's web dialler in a new tab;
// the same click also logs a call Interaction so the timeline carries
// the agent's intent immediately, even before Aircall's webhook fires
// (or, for Google Voice, where no webhook exists at all).

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { PhoneIcon, ChevronDownIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
  phoneE164: string | null
  displayName: string
}

function looksUK(phone: string): boolean {
  return phone.startsWith('+44')
}

function googleVoiceUrl(phone: string): string {
  // GV web accepts `?a=nc,<URI-encoded number>` to prefill the dial pad.
  return `https://voice.google.com/u/0/calls?a=nc,${encodeURIComponent(phone)}`
}

export function CallButton({ contactId, phoneE164, displayName }: Props) {
  const router = useRouter()
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

  const logCall = trpc.interaction.logManualCall.useMutation({
    onSuccess: () => router.refresh(),
    onError: (e) =>
      toast.error(e.message ?? 'Could not log the call — try again from the timeline'),
  })

  function dial(provider: 'aircall' | 'google_voice') {
    if (!phoneE164) {
      toast.error('This contact has no phone number on file.')
      return
    }
    if (provider === 'aircall') {
      // Aircall Phone (desktop / iOS) intercepts tel: links when installed.
      // If it isn't installed, the OS dialler picks it up — acceptable.
      window.location.href = `tel:${phoneE164}`
    } else {
      const url = googleVoiceUrl(phoneE164)
      // Some browsers block window.open without a direct user-gesture
      // chain. The onClick is the gesture so this is fine.
      window.open(url, '_blank', 'noopener,noreferrer')
    }
    logCall.mutate({
      contactId,
      provider,
      direction: 'outbound',
      toNumber: phoneE164,
    })
    setOpen(false)
    toast.success(
      provider === 'aircall'
        ? 'Calling via Aircall — logged on the timeline.'
        : 'Opening Google Voice — call logged on the timeline.',
    )
  }

  const disabled = !phoneE164

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={disabled ? `${displayName} has no phone number on file` : `Call ${displayName}`}
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary-600 px-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PhoneIcon size={14} />
        Call
        <ChevronDownIcon size={12} />
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="menu"
          aria-label="Call options"
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg"
        >
          <p className="border-b border-neutral-100 px-4 py-2 font-mono text-xs text-neutral-500">
            {phoneE164 ?? 'No number'}
          </p>
          <button
            type="button"
            role="menuitem"
            onClick={() => dial('aircall')}
            disabled={!phoneE164}
            className="block w-full px-4 py-2.5 text-left text-sm transition-colors hover:bg-neutral-50 disabled:opacity-50"
          >
            <div className="font-medium text-neutral-900">Aircall</div>
            <div className="text-xs text-neutral-500">
              {phoneE164 && looksUK(phoneE164) ? 'Recommended for UK numbers' : 'Default'}
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => dial('google_voice')}
            disabled={!phoneE164}
            className="block w-full border-t border-neutral-100 px-4 py-2.5 text-left text-sm transition-colors hover:bg-neutral-50 disabled:opacity-50"
          >
            <div className="font-medium text-neutral-900">Google Voice</div>
            <div className="text-xs text-neutral-500">
              {phoneE164 && !looksUK(phoneE164)
                ? 'Recommended for non-UK numbers'
                : 'Opens voice.google.com in a new tab'}
            </div>
          </button>
        </div>
      ) : null}
    </div>
  )
}
