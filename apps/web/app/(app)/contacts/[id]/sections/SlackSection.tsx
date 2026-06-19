// Slack mentions section. RSC — purely presentational.

import type { SlackMention } from '@/lib/view-models/contact-channels'

interface Props {
  mentions: SlackMention[]
  /** Override the empty-state copy (e.g. for a B2B account vs a contact). */
  emptyHint?: string
}

const SENTIMENT_STYLE: Record<string, string> = {
  positive: 'bg-green-100 text-green-900',
  neutral: 'bg-neutral-100 text-neutral-700',
  negative: 'bg-red-100 text-red-900',
}

export function SlackSection({ mentions, emptyHint }: Props): JSX.Element {
  if (mentions.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
        {emptyHint ??
          'No Slack mentions yet — summaries from watched channels that match this contact will appear here.'}
      </div>
    )
  }
  return (
    <ol className="space-y-2">
      {mentions.map((m) => (
        <li key={m.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
            <span>
              {m.channelName ? `#${m.channelName}` : m.channelId ?? 'Slack'}
              {m.senderName && <> · {m.senderName}</>}
              {m.category && (
                <span className="ml-2 rounded bg-primary-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary-800">
                  {m.category}
                </span>
              )}
              {m.sentiment && (
                <span
                  className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    SENTIMENT_STYLE[m.sentiment] ?? SENTIMENT_STYLE['neutral']
                  }`}
                >
                  {m.sentiment}
                </span>
              )}
            </span>
            <time dateTime={new Date(m.occurredAt).toISOString()}>
              {new Intl.DateTimeFormat('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(m.occurredAt))}
            </time>
          </div>
          {m.summary && <p className="mt-1 text-sm text-neutral-900">{m.summary}</p>}
          {m.messageText && (
            <p className="mt-1 text-xs text-neutral-600">{m.messageText}</p>
          )}
          {m.suggestedNextAction && (
            <p className="mt-1 text-xs text-neutral-700">
              <span className="font-medium">Next:</span> {m.suggestedNextAction}
            </p>
          )}
          {m.permalink && (
            <a
              href={m.permalink}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs text-primary-700 hover:underline"
            >
              Open in Slack
            </a>
          )}
        </li>
      ))}
    </ol>
  )
}
