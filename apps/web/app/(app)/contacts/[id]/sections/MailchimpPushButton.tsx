// Idempotent Mailchimp upsert for a contact. CLAUDE.md §16.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

export function MailchimpPushButton({ contactId }: { contactId: string }) {
  const push = trpc.contact.mailchimp.push.useMutation()
  const [busy, setBusy] = useState(false)

  async function onClick() {
    setBusy(true)
    try {
      const result = await push.mutateAsync({ contactId })
      toast.success(`Pushed to Mailchimp (${result.status})`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Push failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-700 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:opacity-50"
    >
      {busy ? 'Pushing…' : 'Push to Mailchimp'}
    </button>
  )
}
