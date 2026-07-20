// Icon-chip stat tile (camp-app style): tinted icon square beside a small
// label over a bold tabular number. Shared by every Summer Camp surface.

import type { ReactNode } from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'

export type StatTileTone = 'primary' | 'success' | 'warn' | 'danger' | 'info' | 'neutral'

const CHIP: Record<StatTileTone, string> = {
  primary: 'bg-primary-50 text-primary-600',
  success: 'bg-emerald-50 text-emerald-600',
  warn: 'bg-amber-50 text-amber-600',
  danger: 'bg-red-50 text-red-600',
  info: 'bg-sky-50 text-sky-600',
  neutral: 'bg-neutral-100 text-neutral-600',
}

export function StatTile({
  icon,
  tone = 'primary',
  label,
  value,
  hint,
}: {
  icon: ReactNode
  tone?: StatTileTone
  label: string
  value: ReactNode
  hint?: string
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span
        aria-hidden="true"
        className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', CHIP[tone])}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs text-neutral-500">{label}</span>
        <span className="block text-lg font-bold tabular-nums text-neutral-900">{value}</span>
        {hint ? <span className="block text-[11px] text-neutral-400">{hint}</span> : null}
      </span>
    </Card>
  )
}
