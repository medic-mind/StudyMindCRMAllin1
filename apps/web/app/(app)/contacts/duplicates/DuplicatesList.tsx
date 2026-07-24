'use client'

// Client island for the duplicates page. Duplicate contacts are merged FULLY
// AUTOMATICALLY (ADR 0047, widened 2026-07) with ZERO manual steps — every
// contact sharing an email or a phone is combined into its oldest record. This
// island runs that merge synchronously on open (`contact.duplicates.drainNow`,
// looping until nothing is left to merge), so a self-hosted Inngest that never
// fires the hourly cron can't leave duplicates un-merged. There is NO manual
// merge UI here — the page only reports status. The single control is
// CONTACTS_AUTO_MERGE=off, which pauses the automation entirely (explicit
// hand-merging, if ever wanted, lives on the /contacts table's select-and-merge
// tool, not on this page).

import { useEffect, useRef, useState } from 'react'

import { trpc, type RouterOutputs } from '@/lib/trpc/client'

type FindResult = RouterOutputs['contact']['duplicates']['find']

export function DuplicatesList({ initialData }: { initialData: FindResult }) {
  const utils = trpc.useUtils()

  // Live query seeded from the server render so the leftover count reflects the
  // post-drain state (normally zero).
  const findQuery = trpc.contact.duplicates.find.useQuery({ limit: 100 }, { initialData })
  const data = findQuery.data ?? initialData

  // Auto-drain on open — no button, no Inngest (mirrors the Slack-mentions
  // tray). Run the fully-automatic merge synchronously in bounded chunks,
  // looping until a pass merges nothing (backlog drained, or only an
  // unmergeable restricted-access conflict remains). Once per mount; a ref
  // guards re-entry.
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
        Duplicate contacts are merged automatically — there is nothing to do here.
      </p>
      <p className="mt-1 text-xs leading-relaxed text-primary-900/80">
        Whenever the same person is saved twice — a shared email, or the same phone number — the CRM
        combines them into their oldest record and moves all their history across. It runs every hour
        and again the moment you open this page, so nothing ever waits for you to review, confirm, or
        merge by hand.
        {draining ? ' Finishing the last few now…' : ''}
      </p>
    </div>
  )

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

  // Kill-switch on (CONTACTS_AUTO_MERGE=off): the automation is paused. Report
  // that — no manual merge queue. Explicit hand-merging lives on the /contacts
  // select-and-merge tool.
  if (autoOff) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Automatic merging is turned off.</p>
          <p className="mt-1 text-xs leading-relaxed">
            Someone set <code>CONTACTS_AUTO_MERGE=off</code>. Remove that setting to turn automatic
            merging back on. While it&apos;s off, duplicates are left as separate records.
          </p>
        </div>
      </div>
    )
  }

  // Auto-merge is on. Anything still here couldn't be merged automatically —
  // only a restricted-access safeguarding conflict (§41.1), which is correct to
  // leave as separate records and needs no action.
  const leftover = data.clusters.length
  if (leftover === 0) {
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
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
        {leftover} group{leftover === 1 ? '' : 's'} could not be merged automatically because of a
        restricted-access safeguarding conflict, so they are kept as separate records by design. No
        action is needed.
      </div>
    </div>
  )
}
