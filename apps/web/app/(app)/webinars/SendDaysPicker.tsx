'use client'

// Mon–Sun toggle for the reminder send-days (0=Mon..6=Sun). Used by the class
// settings and the global webinar settings so "send on Monday and Tuesday"
// stays fully customisable.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function SendDaysPicker({
  value,
  onChange,
  disabled,
}: {
  value: number[]
  onChange: (v: number[]) => void
  disabled?: boolean
}) {
  const set = new Set(value)
  return (
    <div className="flex flex-wrap gap-1.5">
      {DAYS.map((label, i) => {
        const on = set.has(i)
        return (
          <button
            key={label}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => {
              const next = new Set(set)
              if (next.has(i)) next.delete(i)
              else next.add(i)
              onChange([...next].sort((a, b) => a - b))
            }}
            className={
              'h-8 w-12 rounded-md text-sm transition-colors ' +
              (on
                ? 'bg-primary-600 text-white'
                : 'bg-white text-neutral-700 ring-1 ring-neutral-200 hover:bg-neutral-50') +
              (disabled ? ' cursor-not-allowed opacity-60' : '')
            }
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
