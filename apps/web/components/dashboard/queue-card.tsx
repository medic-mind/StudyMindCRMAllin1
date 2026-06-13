// A single "Needs attention" action-queue card for the dashboard. Compact:
// a tone-coloured icon badge, the queue name, its outstanding count, and a
// deep link into the workspace that clears it. An empty queue reads as a calm
// "all clear" rather than an alarm. RSC — pure presentational.

import Link from 'next/link'
import type { ComponentType, SVGProps } from 'react'

import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CoinsIcon,
  HashIcon,
  PhoneIcon,
  RepeatIcon,
  SparklesIcon,
  UserPlusIcon,
} from '@/components/ui/icon'
import type { QueueCard as QueueCardData, QueueIconKey, QueueTone } from '@/lib/dashboard/queues'

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>

const ICONS: Record<QueueIconKey, IconComp> = {
  phone: PhoneIcon,
  userPlus: UserPlusIcon,
  alertTriangle: AlertTriangleIcon,
  hash: HashIcon,
  sparkles: SparklesIcon,
  coins: CoinsIcon,
  repeat: RepeatIcon,
}

const BADGE: Record<QueueTone, string> = {
  info: 'bg-primary-50 text-primary-700',
  warn: 'bg-amber-50 text-amber-700',
  danger: 'bg-rose-50 text-rose-700',
  success: 'bg-emerald-50 text-emerald-600',
}

const COUNT: Record<QueueTone, string> = {
  info: 'text-neutral-900',
  warn: 'text-amber-700',
  danger: 'text-rose-700',
  success: 'text-neutral-400',
}

export function QueueCard({ label, count, href, tone, icon }: Omit<QueueCardData, 'key'>) {
  const Icon = count === 0 ? CheckCircleIcon : ICONS[icon]
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-card transition-shadow hover:shadow-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${BADGE[tone]}`}
      >
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-800">{label}</span>
        <span className="text-xs text-neutral-400">
          {count === 0 ? 'All clear' : count === 1 ? '1 waiting' : `${count} waiting`}
        </span>
      </span>
      <span className={`font-mono text-2xl font-semibold tabular-nums ${COUNT[tone]}`}>
        {count}
      </span>
      <ChevronRightIcon
        size={16}
        className="shrink-0 text-neutral-300 transition-colors group-hover:text-neutral-500"
      />
    </Link>
  )
}
