// Live Slack connectivity check. The single most useful Slack diagnostic:
// "nothing shows from Slack" is almost always the bot NOT being invited to
// the channels where staff discuss customers (Slack's conversations.history
// only reads channels the bot has joined — unlike Trengo's workspace token),
// or SLACK_BOT_TOKEN being unset. This calls Slack directly and lists exactly
// which channels the bot can read, so the gap is obvious. Also fires the
// on-demand pull sync. CEO / Senior Manager (server enforces). CLAUDE.md §12.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

type ProbeResult =
  | {
      ok: true
      botName: string | null
      teamName: string | null
      memberChannels: string[]
      visibleChannels: number
      allowlistActive: boolean
      groupsScopeMissing: boolean
    }
  | { ok: false; error: string }

export function SlackProbeButton(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const probe = trpc.admin.integrations.probeSlack.useMutation({
    onSuccess: (r) => {
      setResult(r)
      if (r.ok) toast.success('Slack API reachable')
      else toast.error('Slack API check failed')
    },
    onError: (e) => {
      setResult({ ok: false, error: e.message ?? 'Probe failed' })
      toast.error(e.message ?? 'Probe failed')
    },
  })

  const syncNow = trpc.slackSummary.unassigned.syncNow.useMutation({
    onSuccess: () =>
      toast.success('Pulling recent Slack messages — mentions will appear shortly.'),
    onError: (e) => toast.error(e.message ?? 'Could not start the sync'),
  })

  const joinAll = trpc.admin.integrations.slackJoinAllChannels.useMutation({
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      if (r.joined.length === 0 && r.failed.length === 0) {
        toast.success(`Already in every public channel (${r.alreadyMember}).`)
      } else {
        toast.success(
          `Joined ${r.joined.length} channel${r.joined.length === 1 ? '' : 's'}` +
            (r.failed.length > 0 ? ` — ${r.failed.length} failed` : '') +
            '. Now run "Sync from Slack now" or a 90-day backfill.',
        )
      }
      // Refresh the membership readout so the change is visible immediately.
      probe.mutate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not join channels'),
  })

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={joinAll.isPending}
          onClick={() => joinAll.mutate()}
          title="Join every public channel in the workspace as the bot, so the pull can read them all — private channels still need /invite"
        >
          {joinAll.isPending ? 'Joining…' : 'Join all public channels'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={syncNow.isPending}
          onClick={() => syncNow.mutate({ lookbackHours: 24 })}
          title="Pull the last day of messages from every channel the bot is in"
        >
          {syncNow.isPending ? 'Syncing…' : 'Sync from Slack now'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={probe.isPending}
          onClick={() => probe.mutate()}
        >
          {probe.isPending ? 'Testing…' : 'Test Slack connection'}
        </Button>
      </div>
      {result ? (
        result.ok ? (
          <div className="max-w-sm space-y-1 text-right">
            <p className="text-xs text-emerald-700">
              Connected{result.botName ? ` as @${result.botName}` : ''}
              {result.teamName ? ` in ${result.teamName}` : ''}.
            </p>
            {result.memberChannels.length > 0 ? (
              <p className="text-xs text-neutral-600">
                Reading {result.memberChannels.length} channel
                {result.memberChannels.length === 1 ? '' : 's'}:{' '}
                <span className="font-mono">{result.memberChannels.join(', ')}</span>
                {result.allowlistActive ? ' (allowlist active)' : ''}
              </p>
            ) : (
              <p className="text-xs text-red-700">
                The bot is in <strong>no channels</strong> — that&apos;s why nothing shows.
                In Slack, run <span className="font-mono">/invite @{result.botName ?? 'the-bot'}</span>{' '}
                in each channel where staff mention customers, then sync.
              </p>
            )}
            {result.groupsScopeMissing ? (
              <p className="text-xs text-amber-700">
                Private channels are excluded — re-install the Slack app with the{' '}
                <span className="font-mono">groups:read</span> +{' '}
                <span className="font-mono">groups:history</span> scopes to include them.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="max-w-sm text-right text-xs text-red-700">Failed: {result.error}</p>
        )
      ) : null}
    </div>
  )
}
