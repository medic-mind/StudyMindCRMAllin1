// Avatar — circle with initials. Deterministic colour by name hash.
// CLAUDE.md §4 (warm secondary used sparingly; avatars stay tonal).

interface Props {
  name: string
  size?: number
  className?: string
}

const PALETTE = [
  'bg-primary-100 text-primary-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-800',
  'bg-violet-100 text-violet-800',
  'bg-rose-100 text-rose-800',
  'bg-sky-100 text-sky-800',
] as const

function initials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : ''
  return (first + last).toUpperCase().slice(0, 2)
}

function hashIndex(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0
  }
  return Math.abs(h) % PALETTE.length
}

export function Avatar({ name, size = 28, className = '' }: Props) {
  const tone = PALETTE[hashIndex(name)]
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${tone} ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.4)),
      }}
    >
      {initials(name)}
    </span>
  )
}
