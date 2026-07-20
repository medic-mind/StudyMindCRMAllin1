// Preset profile pictures (user-management upgrade). A curated set of nice,
// self-contained gradient avatars a user can pick instead of the plain
// initials circle. Rendered as inline SVG (no external asset, no remote host —
// CSP-safe, §44). The stored value is just the key (e.g. "aurora"); rendering
// lives in <Avatar>.

export interface AvatarPreset {
  key: string
  label: string
  /** Gradient stops, top-left → bottom-right. */
  from: string
  via?: string
  to: string
}

// Sixteen tasteful two/three-stop gradients. Keep keys stable — they're stored
// on User.avatarKey.
export const AVATAR_PRESETS: readonly AvatarPreset[] = [
  { key: 'aurora', label: 'Aurora', from: '#6366f1', via: '#8b5cf6', to: '#ec4899' },
  { key: 'ocean', label: 'Ocean', from: '#0ea5e9', via: '#2563eb', to: '#1e3a8a' },
  { key: 'sunset', label: 'Sunset', from: '#f97316', via: '#f43f5e', to: '#c026d3' },
  { key: 'forest', label: 'Forest', from: '#22c55e', via: '#10b981', to: '#0d9488' },
  { key: 'berry', label: 'Berry', from: '#d946ef', via: '#a21caf', to: '#6d28d9' },
  { key: 'citrus', label: 'Citrus', from: '#facc15', via: '#f59e0b', to: '#ea580c' },
  { key: 'sky', label: 'Sky', from: '#38bdf8', via: '#60a5fa', to: '#818cf8' },
  { key: 'rose', label: 'Rose', from: '#fb7185', via: '#f472b6', to: '#e879f9' },
  { key: 'mint', label: 'Mint', from: '#34d399', via: '#2dd4bf', to: '#22d3ee' },
  { key: 'lavender', label: 'Lavender', from: '#a78bfa', via: '#818cf8', to: '#c4b5fd' },
  { key: 'ember', label: 'Ember', from: '#ef4444', via: '#dc2626', to: '#9f1239' },
  { key: 'teal', label: 'Teal', from: '#2dd4bf', via: '#0ea5e9', to: '#3b82f6' },
  { key: 'slate', label: 'Slate', from: '#64748b', via: '#475569', to: '#1e293b' },
  { key: 'gold', label: 'Gold', from: '#fbbf24', via: '#d97706', to: '#92400e' },
  { key: 'grape', label: 'Grape', from: '#8b5cf6', via: '#7c3aed', to: '#4c1d95' },
  { key: 'coral', label: 'Coral', from: '#fca5a5', via: '#fb7185', to: '#f43f5e' },
] as const

const BY_KEY = new Map(AVATAR_PRESETS.map((p) => [p.key, p]))

export function getAvatarPreset(key: string | null | undefined): AvatarPreset | null {
  if (!key) return null
  return BY_KEY.get(key) ?? null
}
