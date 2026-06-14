// Dashboard greeting hero. Opens the home page with a brand-violet wash, a
// time-aware greeting, the date, and a single, honest "what needs you" summary
// with a smart CTA into the busiest queue. RSC — pure presentational; all the
// figures are computed on the server and passed in. CLAUDE.md §4 (brand
// identity, no emoji), §26.

import Link from 'next/link'

import { CheckCircleIcon, ChevronRightIcon, SparklesIcon } from '@/components/ui/icon'

interface TopAction {
  label: string
  href: string
}

interface Props {
  greeting: string
  name: string | null
  dateLabel: string
  /** Total open items across every actionable surface. */
  attentionTotal: number
  /** The single biggest queue to jump to, or null when all clear. */
  topAction: TopAction | null
}

export function GreetingHero({ greeting, name, dateLabel, attentionTotal, topAction }: Props) {
  const allClear = attentionTotal === 0
  return (
    <div className="dash-hero animate-rise overflow-hidden rounded-2xl border border-neutral-200/80 px-5 py-5 shadow-card sm:px-7 sm:py-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-primary-700/80">
            {dateLabel}
          </p>
          <h2 className="mt-1 truncate text-2xl font-semibold tracking-tight text-neutral-900 sm:text-[1.7rem]">
            {greeting}
            {name ? <span className="text-neutral-900">, {name}</span> : null}
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            {allClear ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                <CheckCircleIcon size={16} />
                You&rsquo;re all caught up — nothing in your queues right now.
              </span>
            ) : (
              <>
                You have{' '}
                <span className="font-semibold text-neutral-900">
                  {attentionTotal} item{attentionTotal === 1 ? '' : 's'}
                </span>{' '}
                that need attention today.
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          {allClear ? (
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 shadow-card">
              <SparklesIcon size={24} />
            </span>
          ) : (
            <>
              <div className="text-right">
                <p className="font-mono text-4xl font-semibold leading-none tabular-nums text-neutral-900">
                  {attentionTotal}
                </p>
                <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  to action
                </p>
              </div>
              {topAction ? (
                <Link
                  href={topAction.href}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-primary-600/25 transition-colors hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                >
                  <span className="truncate">Jump to {topAction.label}</span>
                  <ChevronRightIcon size={16} />
                </Link>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
