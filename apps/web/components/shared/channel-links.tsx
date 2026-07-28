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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'

import { useComposeEmail } from '@/components/mail/compose-email'
import { ChevronDownIcon, MailIcon, PencilIcon, PhoneIcon } from '@/components/ui/icon'
import { PhoneInput } from '@/components/ui/phone-input'
import { trpc } from '@/lib/trpc/client'

const E164_RE = /^\+[1-9]\d{6,14}$/u

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  // Fallback for non-secure contexts / older browsers.
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

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
  const compose = useComposeEmail()
  if (!email) return <span className="text-neutral-300">—</span>
  return (
    <a
      href={`mailto:${email}`}
      onClick={(e) => {
        e.stopPropagation()
        // When the in-house composer is mounted (anywhere in the app shell),
        // open it prefilled to this address instead of bouncing out to the OS
        // mail client. Falls back to the mailto href otherwise.
        if (compose) {
          e.preventDefault()
          compose.openCompose({ to: email })
        }
      }}
      className={
        className ??
        'inline-flex max-w-[18rem] items-center gap-1 truncate text-neutral-700 hover:text-primary-700 hover:underline'
      }
      title={`Email ${email} in the CRM`}
    >
      <MailIcon size={12} className="shrink-0 text-neutral-400" />
      <span className="truncate">{email}</span>
    </a>
  )
}

export function PhoneLink({
  phone,
  contactId,
}: {
  phone: string | null | undefined
  /** When set, the menu offers an inline "Edit number" that saves the corrected
   * number onto this contact (audited via `contact.update`). Omit for rows with
   * no single editable contact (e.g. an unlinked missed call). */
  contactId?: string | null
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  // Local override so the corrected number shows instantly after a save, before
  // the server round-trip (router.refresh) reconciles the source data.
  const [localPhone, setLocalPhone] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const savePhone = trpc.contact.update.useMutation({
    onSuccess: () => {
      setLocalPhone(draft)
      setEditing(false)
      setOpen(false)
      toast.success('Number updated')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not update the number'),
  })
  // Portal coords — needed so the menu escapes per-card stacking contexts
  // (CSS transforms on board card <li>s create one each, hiding any
  // `absolute` popover behind the next sibling).
  const [mounted, setMounted] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    setMounted(true)
  }, [])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    function place() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setCoords({ top: rect.bottom + 4, left: rect.left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

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

  // Always drop back to the menu (not the editor) when the popover closes.
  useEffect(() => {
    if (!open) setEditing(false)
  }, [open])

  const shown = localPhone ?? phone
  if (!shown) return <span className="text-neutral-300">—</span>

  const canEdit = Boolean(contactId)
  const draftValid = E164_RE.test(draft)

  return (
    <span className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 font-mono text-neutral-700 hover:text-primary-700 hover:underline"
        title={`Call ${shown}`}
      >
        <PhoneIcon size={12} className="shrink-0 text-neutral-400" />
        <span>{shown}</span>
        <ChevronDownIcon size={10} className="text-neutral-400" />
      </button>
      {open && mounted && coords
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label="Call options"
              onClick={(e) => e.stopPropagation()}
              // Inline z-index in addition to the Tailwind class — defence
              // against a missed JIT pass; the popover MUST sit above the
              // per-card stacking contexts dnd-kit creates.
              style={{
                position: 'fixed',
                top: coords.top,
                left: coords.left,
                zIndex: 9999,
              }}
              // The editor needs `overflow-visible` so the country-code dropdown
              // inside PhoneInput isn't clipped; the plain menu clips as before.
              className={
                editing
                  ? 'z-[9999] w-80 rounded-lg border border-neutral-200 bg-white text-left shadow-xl'
                  : 'z-[9999] w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white text-left shadow-xl'
              }
            >
              {editing ? (
                <div className="p-3">
                  <label className="mb-1.5 block text-xs font-medium text-neutral-700">
                    Edit phone number
                  </label>
                  <PhoneInput value={draft} onChange={setDraft} />
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      disabled={savePhone.isPending}
                      className="rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={savePhone.isPending || !draftValid || !contactId}
                      onClick={() => {
                        if (contactId && draftValid) {
                          savePhone.mutate({ id: contactId, phoneE164: draft })
                        }
                      }}
                      className="rounded-md bg-primary-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {savePhone.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Copy the raw number — the top ask from the team, who could not
                      select the number out of the button. Works everywhere PhoneLink
                      is used (board cards, Contacts / Accounts tables). */}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      const ok = await copyToClipboard(shown)
                      setOpen(false)
                      if (ok) toast.success(`Copied ${shown}`)
                      else toast.error('Could not copy the number')
                    }}
                    className="block w-full border-b border-neutral-100 px-3 py-2 text-left text-xs font-medium text-neutral-900 transition-colors hover:bg-neutral-50"
                  >
                    Copy number
                    <span className="ml-1 select-all font-mono text-neutral-500">{shown}</span>
                  </button>
                  <a
                    role="menuitem"
                    href={`tel:${shown}`}
                    onClick={() => setOpen(false)}
                    className="block px-3 py-2 text-xs transition-colors hover:bg-neutral-50"
                  >
                    <span className="font-medium text-neutral-900">Aircall</span>
                    <span className="ml-1 text-neutral-500">
                      {looksUK(shown) ? '· recommended for UK' : '· tel:'}
                    </span>
                  </a>
                  <a
                    role="menuitem"
                    href={googleVoiceUrl(shown)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setOpen(false)}
                    className="block border-t border-neutral-100 px-3 py-2 text-xs transition-colors hover:bg-neutral-50"
                  >
                    <span className="font-medium text-neutral-900">Google Voice</span>
                    <span className="ml-1 text-neutral-500">
                      {!looksUK(shown) ? '· recommended' : '· new tab'}
                    </span>
                  </a>
                  {/* Fix a wrongly-imported number in place (§16 dial-code bug). */}
                  {canEdit ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setDraft(shown)
                        setEditing(true)
                      }}
                      className="flex w-full items-center gap-1.5 border-t border-neutral-100 px-3 py-2 text-left text-xs font-medium text-neutral-900 transition-colors hover:bg-neutral-50"
                    >
                      <PencilIcon size={12} className="text-neutral-400" />
                      Edit number
                    </button>
                  ) : null}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
