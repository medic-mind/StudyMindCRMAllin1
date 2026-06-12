'use client'

// Client island for the duplicates cleanup page. Each cluster lets the agent
// pick the survivor (defaults to the oldest contact) and merge the rest into
// it. Reuses contact.bulkMerge — audited, re-parents all history, soft-deletes
// the losers (§3: the agent confirms each merge).

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Member {
  id: string
  name: string
  email: string | null
  phoneE164: string | null
  kind: string
  createdAt: Date
  referralSource: string | null
}
interface Cluster {
  survivorId: string
  members: Member[]
}

export function DuplicatesList({
  initialClusters,
  totalClusters,
  duplicateContacts,
  capped,
}: {
  initialClusters: Cluster[]
  totalClusters: number
  duplicateContacts: number
  capped: boolean
}) {
  const utils = trpc.useUtils()
  const [done, setDone] = useState<Set<string>>(new Set())
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkProgress, setBulkProgress] = useState(0)

  const merge = trpc.contact.bulkMerge.useMutation({
    onSuccess: (res, vars) => {
      toast.success(
        `Merged ${res.mergedCount} contact${res.mergedCount === 1 ? '' : 's'} into one`,
      )
      setDone((d) => new Set(d).add(vars.survivorId))
      void utils.contact.duplicates.find.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not merge'),
  })

  const remaining = initialClusters.filter((c) => !done.has(c.survivorId))

  // Bulk action: merge EVERY shown group, oldest contact kept in each.
  // Sequential so one bad group can't abort the rest; the human confirms the
  // whole batch up-front (§3 — confirmed, once for the batch).
  const mergeAll = async () => {
    const groups = initialClusters.filter((c) => !done.has(c.survivorId))
    if (groups.length === 0) return
    const losers = groups.reduce((n, g) => n + g.members.length - 1, 0)
    const msg =
      'Merge ALL ' +
      groups.length +
      ' groups now? The OLDEST contact in each group is kept and ' +
      losers +
      ' duplicate contact(s) are merged into them. All history moves onto the kept contacts. This cannot be undone.'
    if (!window.confirm(msg)) return
    setBulkRunning(true)
    setBulkProgress(0)
    let failures = 0
    for (const g of groups) {
      try {
        await merge.mutateAsync({
          survivorId: g.survivorId,
          loserIds: g.members.map((m) => m.id).filter((id) => id !== g.survivorId),
        })
      } catch {
        failures += 1
      }
      setBulkProgress((n) => n + 1)
    }
    setBulkRunning(false)
    if (failures > 0) {
      toast.error(failures + ' group(s) could not be merged — left in the list')
    } else {
      toast.success('All groups merged')
    }
  }

  if (initialClusters.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-600">
        No duplicate contacts found — everyone with a shared email or phone is
        already a single record. New enquiries now dedupe automatically.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
        <span>
          Found <strong>{totalClusters}</strong> group
          {totalClusters === 1 ? '' : 's'} of duplicates ({duplicateContacts} contacts).{' '}
          {capped ? 'Showing the first 100 — re-run after merging to see more. ' : ''}
          Pick the contact to keep per group, or merge everything in one go.
        </span>
        <Button
          type="button"
          size="sm"
          disabled={bulkRunning || merge.isPending || remaining.length === 0}
          onClick={() => void mergeAll()}
        >
          {bulkRunning
            ? `Merging… ${bulkProgress} done`
            : `Merge all ${remaining.length} groups (keep oldest)`}
        </Button>
      </div>

      {remaining.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          All shown duplicates merged. Refresh to load any remaining groups.
        </div>
      ) : null}

      <ul className="space-y-3">
        {remaining.map((cluster) => (
          <ClusterCard
            key={cluster.survivorId}
            cluster={cluster}
            busy={merge.isPending}
            onMerge={(survivorId) =>
              merge.mutate({
                survivorId,
                loserIds: cluster.members.map((m) => m.id).filter((id) => id !== survivorId),
              })
            }
          />
        ))}
      </ul>
    </div>
  )
}

function ClusterCard({
  cluster,
  busy,
  onMerge,
}: {
  cluster: Cluster
  busy: boolean
  onMerge: (survivorId: string) => void
}) {
  const [survivorId, setSurvivorId] = useState(cluster.survivorId)
  return (
    <li className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {cluster.members.length} duplicates · keep one
        </span>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Merge ${cluster.members.length - 1} contact(s) into "${
                  cluster.members.find((m) => m.id === survivorId)?.name
                }"? All their history moves onto the kept contact and the others are removed. This can't be undone.`,
              )
            ) {
              onMerge(survivorId)
            }
          }}
        >
          {busy ? 'Merging…' : 'Merge into selected'}
        </Button>
      </div>
      <ul className="divide-y divide-neutral-100">
        {cluster.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-1.5 text-sm">
            <input
              type="radio"
              name={`survivor-${cluster.survivorId}`}
              checked={survivorId === m.id}
              onChange={() => setSurvivorId(m.id)}
              aria-label={`Keep ${m.name}`}
            />
            <div className="min-w-0 flex-1">
              <Link
                href={`/contacts/${m.id}`}
                className="font-medium text-neutral-900 hover:underline"
              >
                {m.name}
              </Link>
              <span className="ml-2 text-xs text-neutral-500">
                {m.email ?? '—'}
                {m.phoneE164 ? ` · ${m.phoneE164}` : ''}
              </span>
            </div>
            <span className="shrink-0 text-[11px] text-neutral-400">
              {m.referralSource ? `${m.referralSource} · ` : ''}
              {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
                new Date(m.createdAt),
              )}
              {m.id === cluster.survivorId ? ' · oldest' : ''}
            </span>
          </li>
        ))}
      </ul>
    </li>
  )
}
