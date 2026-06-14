// A single "Needs attention" action-queue card for the dashboard. Compact:
// a tone-tinted icon chip, the queue name + status, and its outstanding count,
// linking into the workspace that clears it. The whole card lifts on hover; an
// empty queue reads as a calm "all clear" rather than an alarm. RSC.

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

const CHIP: Record<QueueTone, string> = {
  info: 'bg-primary-50 text-primary-600 ring-primary-100',
  warn: 'bg-amber-50 text-amber-600 ring-amber-100',
  danger: 'bg-rose-50 text-rose-600 ring-rose-100',
  success: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
}

const COUNT: Record<QueueTone, string> = {
  info: 'text-primary-700',
  warn: 'text-amber-700',
  danger: 'text-rose-700',
  success: 'text-neutral-300',
}

export function QueueCard({ label, count, href, tone, icon }: Omit<QueueCardData, 'key'>) {
  const empty = count === 0
  const Icon = empty ? CheckCircleIcon : ICONS[icon]
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-3.5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
    >
      <span
        aria-hidden="true"
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${CHIP[tone]}`}
      >
        <Icon size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-800">{label}</span>
        <span className="text-xs text-neutral-400">
          {empty ? 'All clear' : 'Needs attention'}
        </span>
      </span>
      <span className={`font-mono text-[1.6rem] font-semibold leading-none tabular-nums ${COUNT[tone]}`}>
        {count}
      </span>
      <ChevronRightIcon
        size={16}
        className="shrink-0 text-neutral-300 transition-transform group-hover:translate-x-0.5 group-hover:text-neutral-500"
      />
    </Link>
  )
}
