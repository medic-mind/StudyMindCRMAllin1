// Notification routing (ADR 0033) — map each kind of message the CRM sends to
// Slack to a channel (or mute it), from the app. No code change to point, say,
// Direct Debit alerts at a different channel. Sits below the channel catalogue
// on /settings/slack-channels.

'use client'

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

export function SlackRoutesAdmin() {
  const router = useRouter()
  const routesQuery = trpc.slackChannel.routes.list.useQuery()
  const channelsQuery = trpc.slackChannel.pickList.useQuery()
  const set = trpc.slackChannel.routes.set.useMutation({
    onSuccess: async () => {
      toast.success('Routing updated')
      await routesQuery.refetch()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not update routing'),
  })

  const routes = routesQuery.data ?? []
  const channels = channelsQuery.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where notifications go</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-4 text-sm text-neutral-600">
          Point each kind of message at any channel you&apos;ve configured above, or
          switch it off. Changes take effect immediately — no code change needed. Leave a
          row on <em>Default</em> to use the default channel (or the legacy env fallback).
        </p>

        {channels.length === 0 ? (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Add a channel above first — then you can route messages to it here.
          </p>
        ) : null}

        <ul className="divide-y divide-neutral-100">
          {routes.map((r) => (
            <li
              key={r.topic}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900">{r.label}</p>
                <p className="text-xs text-neutral-500">{r.description}</p>
                {r.channelArchived ? (
                  <p className="mt-0.5 text-[11px] text-amber-700">
                    Routed channel was archived — falling back to default.
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-neutral-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                    checked={r.enabled}
                    disabled={set.isPending}
                    onChange={(e) =>
                      set.mutate({
                        topic: r.topic,
                        channelOptionId: r.channelOptionId,
                        enabled: e.target.checked,
                      })
                    }
                  />
                  On
                </label>
                <Select
                  aria-label={`Channel for ${r.label}`}
                  value={r.channelOptionId ?? ''}
                  disabled={set.isPending || !r.enabled}
                  onChange={(e) =>
                    set.mutate({
                      topic: r.topic,
                      channelOptionId: e.target.value || null,
                      enabled: r.enabled,
                    })
                  }
                  className="min-w-[12rem]"
                >
                  <option value="">Default / fallback</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}
