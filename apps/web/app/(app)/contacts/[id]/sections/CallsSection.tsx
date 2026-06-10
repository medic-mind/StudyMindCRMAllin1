// Calls section. Inline audio player streams from the signed-URL endpoint;
// transcript expands inline. Outcome badge uses semantic colour.

'use client'

import { useState } from 'react'

import type { CallEntry } from '@/lib/view-models/contact-channels'

interface Props {
  calls: CallEntry[]
}

const OUTCOME_STYLE: Record<CallEntry['outcome'], string> = {
  answered: 'bg-green-100 text-green-900',
  voicemail: 'bg-amber-100 text-amber-900',
  missed: 'bg-red-100 text-red-900',
  unknown: 'bg-neutral-100 text-neutral-700',
}

function fmtDuration(sec: number | null): string {
  if (sec === null) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

function CallRow({ call }: { call: CallEntry }) {
  const [showTranscript, setShowTranscript] = useState(false)
  return (
    <li className="rounded-md border border-neutral-200 bg-white px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
        <span className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${OUTCOME_STYLE[call.outcome]}`}>
            {call.outcome}
          </span>
          <span>{call.direction === 'inbound' ? 'Inbound' : call.direction === 'outbound' ? 'Outbound' : 'Call'}</span>
          <span>· {fmtDuration(call.durationSec)}</span>
          {call.triageRequired && (
            <span className="rounded bg-amber-50 px-1.5 text-[10px] text-amber-800">
              needs assignment
            </span>
          )}
        </span>
        <time dateTime={new Date(call.occurredAt).toISOString()}>
          {new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(call.occurredAt))}
        </time>
      </div>
      {call.hasRecording && (
        <audio
          controls
          preload="none"
          className="mt-2 w-full"
          src={`/api/internal/audio/${call.id}`}
        >
          Your browser does not support inline audio playback.
        </audio>
      )}
      {call.aiOutcome && (
        <div className="mt-2 rounded-md border border-primary-100 bg-primary-50/60 p-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-700">
            AI call summary
          </p>
          <p className="mt-0.5 text-xs text-neutral-800">
            <span className="font-medium capitalize">
              {call.aiOutcome.outcome.replace(/_/g, ' ')}
            </span>
            {call.aiOutcome.sentiment ? (
              <span className="text-neutral-500"> · {call.aiOutcome.sentiment}</span>
            ) : null}
            {call.aiOutcome.confidence != null ? (
              <span className="text-neutral-400">
                {' '}
                · {Math.round(call.aiOutcome.confidence * 100)}% confident
              </span>
            ) : null}
          </p>
          {call.aiOutcome.suggestedFollowUp && (
            <p className="mt-1 text-xs text-neutral-700">
              <span className="font-medium text-neutral-600">Next:</span>{' '}
              {call.aiOutcome.suggestedFollowUp}
            </p>
          )}
        </div>
      )}
      {call.transcript && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setShowTranscript((s) => !s)}
            className="text-xs text-primary-700 hover:underline"
            aria-expanded={showTranscript}
          >
            {showTranscript ? 'Hide transcript' : 'Show transcript'}
          </button>
          {showTranscript && (
            <p className="mt-1 whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs text-neutral-800">
              {call.transcript}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export function CallsSection({ calls }: Props): JSX.Element {
  if (calls.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
        No calls logged yet — answered calls, voicemails, and missed calls from
        Aircall will appear here with recordings where available.
      </div>
    )
  }
  return (
    <ol className="space-y-2">
      {calls.map((c) => (
        <CallRow key={c.id} call={c} />
      ))}
    </ol>
  )
}
