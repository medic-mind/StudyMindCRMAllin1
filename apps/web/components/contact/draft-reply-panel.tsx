// AI reply draft panel. CLAUDE.md §4 (drafts are clearly labelled), §18.
//
// Mounted on Contact detail timeline as an inline client island. Agents
// pick a channel and a goal, generate a draft, edit, then send. Sending a
// Trengo channel (WhatsApp / SMS / web-chat) goes through the existing
// audited outbound path via `interaction.trengo.reply`; email keeps its own
// dedicated reply composer (EmailReplyPanel) so it is omitted here.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

type Channel = 'email' | 'whatsapp' | 'sms' | 'web_chat'

const CHANNEL_LABEL: Record<Channel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  web_chat: 'Web chat',
}

export function DraftReplyPanel({ interactionId }: { interactionId: string }) {
  const [channel, setChannel] = useState<Channel>('email')
  const [goal, setGoal] = useState('')
  const [draft, setDraft] = useState('')
  const [promptVersion, setPromptVersion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generate = trpc.interaction.draftReply.useMutation({
    onSuccess: (out) => {
      setDraft(out.text)
      setPromptVersion(out.promptVersion)
      setError(null)
      toast.success('AI draft ready')
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not generate draft')
    },
  })

  const send = trpc.interaction.trengo.reply.useMutation({
    onSuccess: (out) => {
      setDraft('')
      setError(null)
      toast.success(`Reply sent via ${CHANNEL_LABEL[out.channel as Channel] ?? 'Trengo'}`)
    },
    onError: (e) => {
      setError(e.message)
      toast.error(e.message ?? 'Could not send reply')
    },
  })

  const handleGenerate = () => {
    if (!goal.trim()) {
      setError('Describe the goal of the reply.')
      return
    }
    generate.mutate({ interactionId, goal, channel })
  }

  const handleSend = () => {
    if (!draft.trim()) {
      setError('Nothing to send — generate or write a draft first.')
      return
    }
    send.mutate({ interactionId, body: draft })
  }

  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-neutral-900">Draft reply</h3>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
          AI-drafted — review before sending
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-700">Channel</span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          >
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
            <option value="web_chat">Web chat</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-neutral-700">Goal of reply</span>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. confirm the trial slot for Tuesday 12 May"
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generate.isPending}
          className="rounded bg-primary-600 px-3 py-1 text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {generate.isPending ? 'Drafting…' : 'Generate draft'}
        </button>
        {promptVersion && (
          <span className="text-xs text-neutral-500">prompt {promptVersion}</span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {draft && (
        <>
          <textarea
            aria-label="Draft reply"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="mt-3 w-full rounded border border-neutral-300 bg-white p-2 font-mono text-sm"
          />
          {channel === 'email' ? (
            <p className="mt-2 text-xs text-neutral-500">
              Send this email from the contact’s email composer above.
            </p>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={handleSend}
                disabled={send.isPending}
                className="rounded bg-primary-600 px-3 py-1 text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {send.isPending ? 'Sending…' : `Send via ${CHANNEL_LABEL[channel]}`}
              </button>
              <span className="text-xs text-neutral-500">
                Replies to the contact’s most recent Trengo conversation.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
