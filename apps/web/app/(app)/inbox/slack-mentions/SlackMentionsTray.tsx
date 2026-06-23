// Triage list for unassigned Slack mentions (ADR 0034). Each card shows the
// original message + AI summary/category, with an inline customer search to
// assign (writes the slack_summary record) or a dismiss action.

'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

const SENTIMENT_TONE: Record<string, 'success' | 'neutral' | 'danger'> = {
  positive: 'success',
  neutral: 'neutral',
  negative: 'danger',
}

export function SlackMentionsTray() {
  const utils = trpc.useUtils()
  const listQuery = trpc.slackSummary.unassigned.list.useQuery({ limit: 50 })
  const diagnostics = trpc.slackSummary.unassigned.diagnostics.useQuery(undefined, {
    staleTime: 5 * 60_000,
  })
  const relinkNow = trpc.slackSummary.unassigned.relinkNow.useMutation()
  const syncNow = trpc.slackSummary.unassigned.syncNow.useMutation()
  const items = listQuery.data ?? []
  const aiOff = diagnostics.data?.aiConfigured === false

  async function refresh() {
    await Promise.all([
      utils.slackSummary.unassigned.list.invalidate(),
      utils.slackSummary.unassigned.count.invalidate(),
    ])
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-neutral-500">
        Slack is pulled from every channel the bot is in, every 15 minutes; matching re-runs every 30.
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={syncNow.isPending}
          onClick={async () => {
            try {
              const r = await syncNow.mutateAsync({ lookbackHours: 24 })
              if (r.configured) {
                toast.success('Pulling recent Slack messages from all channels — this can take a minute.')
                setTimeout(() => void refresh(), 6000)
              } else {
                toast.error('Slack isn’t configured (SLACK_BOT_TOKEN missing).')
              }
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Could not start the Slack sync')
            }
          }}
        >
          {syncNow.isPending ? 'Syncing…' : 'Sync from Slack now'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={relinkNow.isPending}
          onClick={async () => {
            try {
              await relinkNow.mutateAsync()
              toast.success(
                'Re-running Slack matching now — newly matched mentions will appear shortly.',
              )
              setTimeout(() => void refresh(), 4000)
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Could not start re-matching')
            }
          }}
        >
          {relinkNow.isPending ? 'Starting…' : 'Re-run matching now'}
        </Button>
      </div>
    </div>
  )

  const banner = aiOff ? (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <span className="font-semibold">AI extractor isn&apos;t configured.</span> Mentions that name
      a customer only by name (no email/phone, and none in the thread above) can&apos;t be
      auto-matched — they&apos;ll keep landing here. Set <code>GEMINI_API_KEY</code> in the
      environment to enable name matching. Mentions carrying a phone/email still link automatically.
    </div>
  ) : null

  if (listQuery.isLoading) {
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-neutral-500">Loading…</p>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="space-y-3">
        {header}
        {banner}
        <Card className="px-10 py-14 text-center">
          <p className="text-sm font-medium text-neutral-800">Nothing to triage.</p>
          <p className="mt-1 text-xs text-neutral-500">
            Slack mentions that confidently match a customer attach automatically. Anything the AI
            couldn&apos;t place lands here.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {header}
      {aiOff ? banner : null}
      <ul className="space-y-3">
        {items.map((m) => (
          <li key={m.id}>
            <MentionCard mention={m} onDone={refresh} />
          </li>
        ))}
      </ul>
    </div>
  )
}

interface Mention {
  id: string
  slackTs: string
  channelId: string
  confidence: number
  messageText: string | null
  senderName: string | null
  createdAt: Date | string
  occurredAt: Date | string
  summary: string | null
  category: string | null
  sentiment: string | null
  suggestedNextAction: string | null
  candidateName: string | null
  candidateEmail: string | null
  candidatePhone: string | null
}

function MentionCard({ mention, onDone }: { mention: Mention; onDone: () => Promise<void> }) {
  const [assigning, setAssigning] = useState<null | 'contact' | 'account'>(null)
  const assign = trpc.slackSummary.unassigned.assign.useMutation()
  const dismiss = trpc.slackSummary.unassigned.dismiss.useMutation()
  const now = new Date()

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span className="font-mono">{mention.channelId}</span>
        {mention.senderName ? <span>· {mention.senderName}</span> : null}
        {mention.category ? <Badge tone="info">{mention.category}</Badge> : null}
        {mention.sentiment ? (
          <Badge tone={SENTIMENT_TONE[mention.sentiment] ?? 'neutral'}>{mention.sentiment}</Badge>
        ) : null}
        <span className="ml-auto">{formatRelativeTime(new Date(mention.occurredAt), now)}</span>
      </div>

      {mention.summary ? (
        <p className="mt-2 text-sm font-medium text-neutral-900">{mention.summary}</p>
      ) : null}
      {mention.messageText ? (
        <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-600">{mention.messageText}</p>
      ) : null}

      <p className="mt-2 text-[11px] text-neutral-500">
        AI guess:{' '}
        {[mention.candidateName, mention.candidateEmail, mention.candidatePhone]
          .filter(Boolean)
          .join(' · ') || 'no identifier found'}{' '}
        · confidence {(mention.confidence * 100).toFixed(0)}%
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {assigning === 'contact' ? (
          <ContactPicker
            initialQuery={mention.candidateName ?? mention.candidateEmail ?? ''}
            onPick={async (contactId) => {
              try {
                await assign.mutateAsync({ id: mention.id, contactId })
                toast.success('Saved to the customer’s timeline')
                await onDone()
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not assign')
              }
            }}
            onCancel={() => setAssigning(null)}
            busy={assign.isPending}
          />
        ) : assigning === 'account' ? (
          <AccountPicker
            initialQuery={mention.candidateName ?? ''}
            onPick={async (businessAccountId) => {
              try {
                await assign.mutateAsync({ id: mention.id, businessAccountId })
                toast.success('Saved to the school/partner timeline')
                await onDone()
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not assign')
              }
            }}
            onCancel={() => setAssigning(null)}
            busy={assign.isPending}
          />
        ) : (
          <>
            <Button type="button" size="sm" onClick={() => setAssigning('contact')}>
              Assign to customer
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setAssigning('account')}
            >
              Assign to school/B2B
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={dismiss.isPending}
              onClick={async () => {
                try {
                  await dismiss.mutateAsync({ id: mention.id })
                  toast.message('Dismissed')
                  await onDone()
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Could not dismiss')
                }
              }}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}

function ContactPicker({
  initialQuery,
  onPick,
  onCancel,
  busy,
}: {
  initialQuery: string
  onPick: (contactId: string) => void | Promise<void>
  onCancel: () => void
  busy: boolean
}) {
  const [q, setQ] = useState(initialQuery)
  const [debounced, setDebounced] = useState(initialQuery)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])
  const results = trpc.contact.list.useQuery(
    { q: debounced, limit: 6 },
    { enabled: debounced.trim().length >= 2 },
  )
  const items = results.data?.items ?? []

  return (
    <div className="w-full max-w-md rounded-md border border-primary-200 bg-primary-50/40 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search customers by name, email, phone…"
          autoFocus
        />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {debounced.trim().length >= 2 ? (
        <ul className="mt-2 max-h-48 divide-y divide-neutral-100 overflow-y-auto rounded bg-white">
          {results.isLoading ? (
            <li className="px-3 py-2 text-xs text-neutral-500">Searching…</li>
          ) : items.length === 0 ? (
            <li className="px-3 py-2 text-xs text-neutral-500">No matches.</li>
          ) : (
            items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onPick(c.id)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 disabled:opacity-50"
                >
                  <span className="font-medium text-neutral-900">{c.displayName}</span>
                  <span className="truncate text-xs text-neutral-500">
                    {c.email ?? c.phoneE164 ?? ''}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : (
        <p className="mt-2 px-1 text-[11px] text-neutral-500">Type at least 2 characters.</p>
      )}
    </div>
  )
}

function AccountPicker({
  initialQuery,
  onPick,
  onCancel,
  busy,
}: {
  initialQuery: string
  onPick: (businessAccountId: string) => void | Promise<void>
  onCancel: () => void
  busy: boolean
}) {
  const [q, setQ] = useState(initialQuery)
  // The active set is small — load it once and filter client-side.
  const accounts = trpc.businessAccount.pickList.useQuery({})
  const all = accounts.data ?? []
  const needle = q.trim().toLowerCase()
  const items = (needle.length === 0 ? all : all.filter((a) => a.name.toLowerCase().includes(needle))).slice(
    0,
    8,
  )

  return (
    <div className="w-full max-w-md rounded-md border border-primary-200 bg-primary-50/40 p-2">
      <div className="flex items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search schools / B2B partners by name…"
          autoFocus
        />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <ul className="mt-2 max-h-48 divide-y divide-neutral-100 overflow-y-auto rounded bg-white">
        {accounts.isLoading ? (
          <li className="px-3 py-2 text-xs text-neutral-500">Loading…</li>
        ) : items.length === 0 ? (
          <li className="px-3 py-2 text-xs text-neutral-500">No matching accounts.</li>
        ) : (
          items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onPick(a.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 disabled:opacity-50"
              >
                <span className="font-medium text-neutral-900">{a.name}</span>
                <span className="text-xs uppercase tracking-wide text-neutral-500">{a.kind}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
