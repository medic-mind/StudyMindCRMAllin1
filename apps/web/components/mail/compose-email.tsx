// In-house email composer — a single global modal mounted in the app shell, so
// any "email" affordance across the CRM (board cards, Contacts/Accounts list
// rows, contact pages) opens an in-CRM compose sent from the agent's connected
// Gmail (ADR 0021 mail.compose) instead of a `mailto:` that bounces the agent
// out to a separate mail client.
//
// Usage: mount <ComposeEmailProvider canSend> once around the app shell, then
// from anywhere call `useComposeEmail()?.openCompose({ to, subject?, body? })`.
// Consumers use the *optional* hook so a component (or a test) still renders
// when no provider is mounted — `EmailLink` falls back to mailto in that case.

'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button, type ButtonProps } from '@/components/ui/button'
import { MailIcon, SendIcon, XIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

export interface ComposeEmailOptions {
  to?: string
  subject?: string
  body?: string
}

interface ComposeEmailContextValue {
  openCompose: (opts?: ComposeEmailOptions) => void
}

const ComposeEmailContext = createContext<ComposeEmailContextValue | null>(null)

/** Returns the composer when a provider is mounted, otherwise null. */
export function useComposeEmail(): ComposeEmailContextValue | null {
  return useContext(ComposeEmailContext)
}

export function ComposeEmailProvider({
  canSend,
  children,
}: {
  canSend: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [opts, setOpts] = useState<ComposeEmailOptions>({})

  const openCompose = useCallback((next?: ComposeEmailOptions) => {
    setOpts(next ?? {})
    setOpen(true)
  }, [])

  const value = useMemo(() => ({ openCompose }), [openCompose])

  return (
    <ComposeEmailContext.Provider value={value}>
      {children}
      {open ? (
        // `key` resets the modal's internal field state each time it opens with
        // fresh options (e.g. a different recipient).
        <ComposeEmailModal
          key={`${opts.to ?? ''}|${opts.subject ?? ''}`}
          canSend={canSend}
          initial={opts}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </ComposeEmailContext.Provider>
  )
}

/**
 * A button that opens the in-house composer prefilled. Drop-in anywhere under
 * the provider (contact header, card modal, account page). Falls back to a
 * mailto when no provider is mounted.
 */
export function ComposeEmailButton({
  to,
  subject,
  body,
  children,
  ...buttonProps
}: {
  to?: string
  subject?: string
  body?: string
} & Omit<ButtonProps, 'onClick'>) {
  const compose = useComposeEmail()
  return (
    <Button
      type="button"
      onClick={() => {
        if (compose) compose.openCompose({ to, subject, body })
        else if (typeof window !== 'undefined') window.location.href = `mailto:${to ?? ''}`
      }}
      {...buttonProps}
    >
      {children ?? (
        <>
          <MailIcon size={14} /> Email
        </>
      )}
    </Button>
  )
}

function ComposeEmailModal({
  canSend,
  initial,
  onClose,
}: {
  canSend: boolean
  initial: ComposeEmailOptions
  onClose: () => void
}) {
  const accountsQuery = trpc.mail.accounts.useQuery()
  const accounts = accountsQuery.data ?? []
  const compose = trpc.mail.compose.useMutation()

  const [accountId, setAccountId] = useState('')
  const [to, setTo] = useState(initial.to ?? '')
  const [subject, setSubject] = useState(initial.subject ?? '')
  const [body, setBody] = useState(initial.body ?? '')

  // Default the From account to the first available once accounts load.
  const effectiveAccountId = accountId || accounts[0]?.id || ''

  async function send() {
    const recipients = to
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (recipients.length === 0 || !subject.trim() || !body.trim() || !effectiveAccountId) {
      toast.error('Add a recipient, subject and message.')
      return
    }
    try {
      await compose.mutateAsync({
        mailAccountId: effectiveAccountId,
        to: recipients,
        subject: subject.trim(),
        body: body.trim(),
      })
      toast.success('Email sent')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the email')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New email"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
            <MailIcon size={15} className="text-primary-600" /> New email
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100"
          >
            <XIcon size={16} />
          </button>
        </div>

        {accountsQuery.isLoading ? (
          <p className="p-4 text-sm text-neutral-500">Loading your mailboxes…</p>
        ) : accounts.length === 0 ? (
          <div className="space-y-2 p-4 text-sm text-neutral-600">
            <p>You have no email account connected to send from.</p>
            <a href="/settings/email-accounts" className="font-medium text-primary-700 hover:underline">
              Connect an email account →
            </a>
          </div>
        ) : (
          <>
            <div className="space-y-2 p-4">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                From
              </label>
              <select
                value={effectiveAccountId}
                onChange={(e) => setAccountId(e.target.value)}
                aria-label="From"
                className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-200"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} <${a.address}>` : a.address}
                  </option>
                ))}
              </select>
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="To: name@example.com, …"
                aria-label="To"
              />
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                aria-label="Subject"
              />
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                placeholder="Write your message…"
                aria-label="Message"
              />
              {!canSend ? (
                <p className="text-xs text-amber-700">
                  Your role can draft but not send email from the CRM. Ask a Sales Executive or
                  above to send.
                </p>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-4 py-2.5">
              <Button type="button" size="sm" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canSend || compose.isPending}
                onClick={send}
              >
                <SendIcon size={15} /> {compose.isPending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
