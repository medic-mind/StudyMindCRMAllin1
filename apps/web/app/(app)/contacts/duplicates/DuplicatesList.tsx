'use client'

// Client island for the duplicates page. Duplicate contacts are merged FULLY
// AUTOMATICALLY (ADR 0047, widened 2026-07) — every contact sharing an email or
// a phone is combined into its oldest record, with no human step. This island
// just finishes that work on demand: on open it drains the whole backlog
// synchronously (`contact.duplicates.drainNow`, looping until nothing is left to
// merge), so a self-hosted Inngest that never fires the hourly cron can't leave
// duplicates piling up asking for a manual merge. The only human control is
// CONTACTS_AUTO_MERGE=off, which pauses the automation — then, and only then, the
// manual per-group merge below is offered (the "fall back to fully-manual" path
// of ADR 0047). A group that genuinely can't be auto-merged (a restricted-access
// safeguarding conflict, §41.1) is the one other case a human still resolves.

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc, type RouterOutputs } from '@/lib/trpc/client'

type FindResult = RouterOutputs['contact']['duplicates']['find']
type Cluster = FindResult['clusters'][number]
type Member = Cluster['members'][number]

export function DuplicatesList({ initialData }: { initialData: FindResult }) {
  const utils = trpc.useUtils()

  // Live query seeded from the server render, so the list reflects the current
  // state — in particular it empties out after the auto-drain below invalidates.
  const findQuery = trpc.contact.duplicates.find.useQuery({ limit: 100 }, { initialData })
  const data = findQuery.data ?? initialData

  // Auto-drain on open — no button, no Inngest (mirrors the Slack-mentions tray).
  // Run the fully-automatic merge synchronously in bounded chunks, looping until
  // a pass merges nothing (backlog drained, or only an unmergeable conflict
  // remains). Once per mount; a ref guards re-entry.
  const drain = trpc.contact.duplicates.drainNow.useMutation()
  const hasBacklog = (initialData.totalClusters ?? 0) > 0
  const [draining, setDraining] = useState(hasBacklog)
  const [autoOff, setAutoOff] = useState(false)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!hasBacklog) return
    let cancelled = false
    void (async () => {
      setDraining(true)
      try {
        // Bounded loop; each call merges up to a few hundred. 40 iterations
        // clears a very large historic backlog — any remainder clears on the
        // next visit or the hourly cron.
        for (let i = 0; i < 40; i += 1) {
          const r = await drain.mutateAsync({})
          if (cancelled) return
          if (r.disabled) {
            setAutoOff(true)
            break
          }
          if (r.done) break
        }
      } catch {
        // Best-effort — the hourly cron is the backstop.
      } finally {
        if (!cancelled) {
          setDraining(false)
          await utils.contact.duplicates.find.invalidate()
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // Run once on mount; the mutation + utils objects are stable.
  }, [])

  const header = (
    <div className="rounded-lg border border-primary-200 bg-primary-50/60 px-4 py-3 text-sm text-primary-900">
      <p className="font-semibold">
        Duplicate contacts are merged automatically — you don&apos;t need this page.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-primary-900/80">
        Whenever the same person is saved twice — a shared email, or the same phone number — the CRM
        combines them into their oldest record and moves all their history across. It runs every hour
        and again the moment you open this page, so nothing ever waits for you to review or confirm
        it.
        {draining ? ' Finishing the last few now…' : ''}
      </p>
    </div>
  )

  // Still merging the backlog — never flash the manual "merge these" UI.
  if (draining) {
    return (
      <div className="space-y-4">
        {header}
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-600">
          Merging duplicates…
        </div>
      </div>
    )
  }

  // Kill-switch on (CONTACTS_AUTO_MERGE=off): the automation is paused, so fall
  // back to fully-manual review (ADR 0047).
  if (autoOff) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <strong>Automatic merging is turned off</strong> (<code>CONTACTS_AUTO_MERGE=off</code>).
          Review and merge each group by hand below, or remove that setting to turn automation back
          on.
        </div>
        <ManualReview data={data} />
      </div>
    )
  }

  // Auto-merge is on. If anything is left it couldn't be merged automatically
  // (e.g. a restricted-access safeguarding conflict, §41.1) — the one case a
  // human still resolves. Otherwise there is genuinely nothing to do.
  if (data.clusters.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-600">
          All clear — every contact with a shared email or phone is already a single record. New
          duplicates are merged automatically as they appear.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {header}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
        A few groups couldn&apos;t be merged automatically and need a manual check — usually a
        restricted-access safeguarding conflict.
      </div>
      <ManualReview data={data} />
    </div>
  )
}

// Manual per-group merge, reused for the two fallback cases above. Merging runs
// through the audited contact.bulkMerge path — re-parents all history onto the
// survivor and soft-deletes the losers.
function ManualReview({ data }: { data: FindResult }) {
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

  const remaining = data.clusters.filter((c) => !done.has(c.survivorId))

  // Merge EVERY shown group in one go, keeping the oldest contact in each.
  // Sequential so one bad group can't abort the rest; confirmed once for the
  // batch.
  const mergeAll = async () => {
    if (remaining.length === 0) return
    const losers = remaining.reduce((n, g) => n + g.members.length - 1, 0)
    const msg =
      'Merge ALL ' +
      remaining.length +
      ' groups now? The OLDEST contact in each group is kept and ' +
      losers +
      ' duplicate contact(s) are merged into them. All history moves onto the kept contacts. This cannot be undone.'
    if (!window.confirm(msg)) return
    setBulkRunning(true)
    setBulkProgress(0)
    let failures = 0
    for (const g of remaining) {
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

  if (remaining.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        All shown duplicates merged. Refresh to load any remaining groups.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm text-neutral-700">
        <span>
          <strong>{data.totalClusters}</strong> group{data.totalClusters === 1 ? '' : 's'} to review
          ({data.duplicateContacts} contacts).{' '}
          {data.capped ? 'Showing the first 100 — refresh after merging to see more. ' : ''}
          Pick the contact to keep per group, or merge everything in one go.
        </span>
        <Button
          type="button"
          size="sm"
          disabled={bulkRunning || merge.isPending}
          onClick={() => void mergeAll()}
        >
          {bulkRunning
            ? `Merging… ${bulkProgress} done`
            : `Merge all ${remaining.length} groups (keep oldest)`}
        </Button>
      </div>

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
        {cluster.members.map((m: Member) => (
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
