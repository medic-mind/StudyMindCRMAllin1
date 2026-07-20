// Avatar — a preset gradient profile picture (with initials) when the user has
// chosen one, otherwise a tonal initials circle. Deterministic colour by name
// hash for the fallback. CLAUDE.md §4 (avatars stay tonal); §44 (self-contained
// inline SVG, no remote host).

import { getAvatarPreset } from './avatar-presets'

interface Props {
  name: string
  /** Chosen preset key (User.avatarKey). Null → initials fallback. */
  avatarKey?: string | null
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

function hashIndex(name: string, mod: number): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0
  }
  return Math.abs(h) % mod
}

export function Avatar({ name, avatarKey, size = 28, className = '' }: Props) {
  const preset = getAvatarPreset(avatarKey)

  if (preset) {
    // A unique gradient id per (preset,size) so multiple avatars on a page
    // don't collide, without pulling in a random source.
    const gradId = `av-${preset.key}-${size}`
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`}
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} viewBox="0 0 40 40" role="img">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor={preset.from} />
              {preset.via ? <stop offset="50%" stopColor={preset.via} /> : null}
              <stop offset="100%" stopColor={preset.to} />
            </linearGradient>
          </defs>
          <circle cx="20" cy="20" r="20" fill={`url(#${gradId})`} />
          <text
            x="20"
            y="21"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="16"
            fontWeight="600"
            fill="#ffffff"
            fillOpacity="0.95"
            fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          >
            {initials(name)}
          </text>
        </svg>
      </span>
    )
  }

  const tone = PALETTE[hashIndex(name, PALETTE.length)]
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
