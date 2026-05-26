// Call summary section inside the card detail modal (slice B). An agent
// records a call's outcome + notes, saves it (a call_summary Interaction on
// the backing contact), then optionally fans it out to Slack / Trengo / email
// via a small popover with per-channel checkboxes. Channels that are not
// actionable are disabled with a reason. On send we surface per-channel
// success/failure toasts. CLAUDE.md §26, §28, §20.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

type Outcome = 'answered' | 'voicemail' | 'no_answer'
type ChannelKey = 'slack' | 'trengo' | 'email'

interface Props {
  cardId: string
  canWrite: boolean
}

const OUTCOME_LABELS: Record<Outcome, string> = {
  answered: 'Answered',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
}

export function CallSummarySection({ cardId, canWrite }: Props) {
  const [body, setBody] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('answered')
  const [savedSummaryId, setSavedSummaryId] = useState<string | null>(null)
  const [showSend, setShowSend] = useState(false)
  const [channels, setChannels] = useState<Record<ChannelKey, boolean>>({
    slack: true,
    trengo: false,
    email: false,
  })
  const [slackChannelId, setSlackChannelId] = useState('')

  const availability = trpc.card.callSummary.availability.useQuery(
    { cardId },
    { enabled: canWrite },
  )

  const add = trpc.card.callSummary.add.useMutation({
    onSuccess: (data) => {
      toast.success('Call summary saved')
      setSavedSummaryId(data?.id ?? null)
    },
    onError: (e) => toast.error(e.message ?? 'Could not save call summary'),
  })

  const send = trpc.card.callSummary.send.useMutation({
    onSuccess: (results) => {
      const entries = Object.entries(results ?? {}) as Array<
        [ChannelKey, { status: string; detail?: string }]
      >
      for (const [channel, result] of entries) {
        if (result.status === 'sent') toast.success(`${channel}: sent`)
        else if (result.status === 'failed') {
          toast.error(`${channel}: failed${result.detail ? ` — ${result.detail}` : ''}`)
        } else toast.message(`${channel}: skipped${result.detail ? ` — ${result.detail}` : ''}`)
      }
      setShowSend(false)
    },
    onError: (e) => toast.error(e.message ?? 'Could not send call summary'),
  })

  if (!canWrite) return null

  const avail = availability.data
  const slackReason = avail?.slack.available ? undefined : 'No Slack channel configured'
  const trengoReason = avail?.trengo.available
    ? undefined
    : avail?.trengo.hasPhone
      ? 'No Trengo conversation for this contact'
      : 'Contact has no phone number'
  const emailReason = avail?.email.available
    ? undefined
    : !avail?.email.hasEmail
      ? 'Contact has no email address'
      : !avail?.email.gmailConnected
        ? 'No Gmail connected for you'
        : 'No Gmail thread for this contact'

  function channelRow(key: ChannelKey, label: string, reason: string | undefined) {
    const disabled = Boolean(reason)
    return (
      <label
        className={`flex items-center gap-2 text-sm ${disabled ? 'text-neutral-400' : 'text-neutral-800'}`}
        title={reason}
      >
        <input
          type="checkbox"
          checked={!disabled && channels[key]}
          disabled={disabled}
          onChange={(e) => setChannels((c) => ({ ...c, [key]: e.target.checked }))}
        />
        {label}
        {reason ? <span className="text-xs text-neutral-400">({reason})</span> : null}
      </label>
    )
  }

  const anyChannelSelected =
    (!slackReason && channels.slack) ||
    (!trengoReason && channels.trengo) ||
    (!emailReason && channels.email)

  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Call summary
      </h3>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <span className="w-16 shrink-0">Outcome</span>
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as Outcome)}
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
            aria-label="Call outcome"
          >
            {(Object.keys(OUTCOME_LABELS) as Outcome[]).map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
        <textarea
          rows={3}
          value={body}
          maxLength={4000}
          placeholder="What happened on the call?"
          onChange={(e) => {
            setBody(e.target.value)
            setSavedSummaryId(null)
          }}
          className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
          aria-label="Call summary notes"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={add.isPending || body.trim().length === 0}
            onClick={() => add.mutate({ cardId, body, outcome })}
          >
            {add.isPending ? 'Saving…' : 'Save summary'}
          </Button>
          {savedSummaryId ? (
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowSend((s) => !s)}
                aria-expanded={showSend}
              >
                Send call summary
              </Button>
              {showSend ? (
                <div
                  role="dialog"
                  aria-label="Send call summary channels"
                  className="absolute z-10 mt-1 w-72 rounded-md border border-neutral-200 bg-white p-3 shadow-lg"
                >
                  <p className="mb-2 text-xs font-medium text-neutral-500">Send to</p>
                  <div className="flex flex-col gap-1.5">
                    {channelRow('slack', 'Slack', slackReason)}
                    {channelRow('trengo', 'Trengo', trengoReason)}
                    {channelRow('email', 'Email', emailReason)}
                  </div>
                  {!slackReason && channels.slack ? (
                    <label className="mt-2 block text-xs text-neutral-600">
                      Slack channel override (optional)
                      <input
                        type="text"
                        value={slackChannelId}
                        onChange={(e) => setSlackChannelId(e.target.value)}
                        placeholder="C0123456789"
                        className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                      />
                    </label>
                  ) : null}
                  <div className="mt-3 flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSend(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={send.isPending || !anyChannelSelected}
                      onClick={() =>
                        send.mutate({
                          summaryInteractionId: savedSummaryId,
                          channels: {
                            slack: !slackReason && channels.slack,
                            trengo: !trengoReason && channels.trengo,
                            email: !emailReason && channels.email,
                          },
                          slackChannelId:
                            !slackReason && channels.slack && slackChannelId.trim().length > 0
                              ? slackChannelId.trim()
                              : undefined,
                        })
                      }
                    >
                      {send.isPending ? 'Sending…' : 'Send'}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
