// Start a brand-new Trengo conversation with this contact (ADR 0020 Phase 6j).
// Client island on the contact's Trengo section. Picks a channel + body and
// fires interaction.trengo.startConversation, which resolves the recipient
// from the contact (phone / email), creates the Trengo conversation, and
// mirrors a head so it appears in the inbox at once. Sales Executive+.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

type Channel = 'whatsapp' | 'sms' | 'email' | 'web_chat'

const CHANNELS: ReadonlyArray<{ value: Channel; label: string }> = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
]

export function StartTrengoConversation({ contactId }: { contactId: string }) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<Channel>('whatsapp')
  const [body, setBody] = useState('')

  const start = trpc.interaction.trengo.startConversation.useMutation({
    onSuccess: () => {
      toast.success('Conversation started')
      setBody('')
      setOpen(false)
      void utils.contact.channels.trengoConversations.invalidate({ contactId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not start the conversation'),
  })

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        New conversation
      </button>
    )
  }

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3 text-sm shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          New conversation
        </span>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
          aria-label="Channel"
        >
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="First message…"
        className="mt-2 w-full rounded border border-neutral-300 bg-white p-2 text-sm focus:border-primary-500 focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => start.mutate({ contactId, channel, body })}
          disabled={start.isPending || !body.trim()}
          className="rounded bg-primary-600 px-3 py-1 text-xs text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {start.isPending ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-500 hover:underline"
        >
          Cancel
        </button>
        <span className="text-xs text-neutral-400">
          WhatsApp/SMS uses the contact’s phone; Email uses their email.
        </span>
      </div>
    </div>
  )
}
