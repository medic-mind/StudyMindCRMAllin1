'use client'

// Reply to an email thread from the CRM (ADR 0021 Phase 4). Sends via Gmail
// (the account owner's mailbox) and threads against the latest inbound message;
// the sent reply appears in Gmail too. Sales Executive+; the server enforces.
// CLAUDE.md §14, §20, §26.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function EmailReply({ conversationId }: { conversationId: string }) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const reply = trpc.mail.thread.reply.useMutation()

  async function send() {
    const trimmed = body.trim()
    if (!trimmed) return
    try {
      await reply.mutateAsync({ conversationId, body: trimmed })
      toast.success('Reply sent')
      setBody('')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the reply')
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
      <label htmlFor="email-reply" className="sr-only">
        Reply
      </label>
      <textarea
        id="email-reply"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        placeholder="Write a reply… (sends from this mailbox and syncs to Gmail)"
        className="w-full resize-y rounded-md border border-neutral-200 px-3 py-2 text-sm focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-200"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-neutral-400">
          Replies the latest message on this thread.
        </span>
        <Button
          type="button"
          size="sm"
          disabled={reply.isPending || !body.trim()}
          onClick={send}
        >
          {reply.isPending ? 'Sending…' : 'Send reply'}
        </Button>
      </div>
    </div>
  )
}
