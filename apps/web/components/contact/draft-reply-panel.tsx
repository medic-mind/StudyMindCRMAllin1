// AI reply draft panel. CLAUDE.md §4 (drafts are clearly labelled), §18.
//
// Mounted on Contact detail timeline as an inline client island. Agents
// pick a channel and a goal, generate a draft, edit, then confirm. Send
// itself goes through the existing per-channel outbound path (Trengo,
// Gmail) — this component never sends; it produces an editable draft.

'use client'

import { useState } from 'react'

import { trpc } from '@/lib/trpc/client'

type Channel = 'email' | 'whatsapp' | 'sms' | 'web_chat'

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
    },
    onError: (e) => setError(e.message),
  })

  const handleGenerate = () => {
    if (!goal.trim()) {
      setError('Describe the goal of the reply.')
      return
    }
    generate.mutate({ interactionId, goal, channel })
  }

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">Draft reply</h3>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
          AI-drafted — review before sending
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-700">Channel</span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
            className="rounded border border-slate-300 bg-white px-2 py-1"
          >
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
            <option value="web_chat">Web chat</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-700">Goal of reply</span>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. confirm the trial slot for Tuesday 12 May"
            className="rounded border border-slate-300 bg-white px-2 py-1"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generate.isPending}
          className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
        >
          {generate.isPending ? 'Drafting…' : 'Generate draft'}
        </button>
        {promptVersion && (
          <span className="text-xs text-slate-500">prompt {promptVersion}</span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {draft && (
        <textarea
          aria-label="Draft reply"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={8}
          className="mt-3 w-full rounded border border-slate-300 bg-white p-2 font-mono text-sm"
        />
      )}
    </div>
  )
}
