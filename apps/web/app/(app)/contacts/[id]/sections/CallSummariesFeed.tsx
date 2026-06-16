// Compiled call-summaries feed (ADR 0039 amendment). Lists call summaries for
// this contact from BOTH the CRM wizard ('site') and watched Slack channels
// ('slack'), newest-first, each tagged with its source — so a summary logged on
// the site and one posted in Slack land in the same place. RSC, presentational.

import type { CallSummaryEntry } from '@/lib/view-models/contact-channels'

interface Props {
  summaries: CallSummaryEntry[]
}

const OUTCOME_LABEL: Record<string, string> = {
  answered: 'Answered',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
}

export function CallSummariesFeed({ summaries }: Props): JSX.Element {
  if (summaries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
        No call summaries yet — anything logged here or posted about this contact in your
        #callsummaries Slack channel will appear here automatically.
      </div>
    )
  }
  return (
    <ol className="space-y-2">
      {summaries.map((s) => (
        <li key={s.id} className="rounded-md border border-neutral-200 bg-white px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
            <span className="flex flex-wrap items-center gap-1.5">
              <span
                className={
                  s.source === 'slack'
                    ? 'rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-800'
                    : 'rounded bg-primary-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary-800'
                }
              >
                {s.source === 'slack' ? 'Slack' : 'CRM'}
              </span>
              {s.source === 'slack' && s.channelName ? <span>#{s.channelName}</span> : null}
              {s.authorName ? <span>· {s.authorName}</span> : null}
              {s.outcome && OUTCOME_LABEL[s.outcome] ? (
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-600">
                  {OUTCOME_LABEL[s.outcome]}
                </span>
              ) : null}
              {s.category ? (
                <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700">
                  {s.category}
                </span>
              ) : null}
            </span>
            <time dateTime={new Date(s.occurredAt).toISOString()}>
              {new Intl.DateTimeFormat('en-GB', {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(s.occurredAt))}
            </time>
          </div>
          {s.summary ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-900">{s.summary}</p>
          ) : null}
          {s.permalink ? (
            <a
              href={s.permalink}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs text-primary-700 hover:underline"
            >
              Open in Slack
            </a>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
