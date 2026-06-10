// Resolve a PipelineStage.color token to a concrete CSS colour.
// ADR 0015. The stored value can be either a Tailwind palette name
// ("blue-500", "emerald-500") chosen from a fixed picker on the manage
// page, or a hex string. Tailwind JIT cannot resolve arbitrary class
// strings at build time, so we map the token to a hex value here and
// render via inline style.

export interface StageColorOption {
  /** Stored token, e.g. "blue-500". */
  token: string
  /** Human label shown in the picker. */
  label: string
  /** Concrete CSS colour (Tailwind palette-500 / -600 values). */
  hex: string
}

export const STAGE_COLOR_OPTIONS: ReadonlyArray<StageColorOption> = [
  { token: 'blue-500', label: 'Blue', hex: '#3b82f6' },
  { token: 'amber-500', label: 'Amber', hex: '#f59e0b' },
  { token: 'emerald-500', label: 'Emerald', hex: '#10b981' },
  { token: 'orange-600', label: 'Orange', hex: '#ea580c' },
  { token: 'rose-600', label: 'Rose', hex: '#e11d48' },
  { token: 'violet-500', label: 'Violet', hex: '#8b5cf6' },
  { token: 'sky-500', label: 'Sky', hex: '#0ea5e9' },
  { token: 'slate-500', label: 'Slate', hex: '#64748b' },
]

const HEX_RE = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i

// Full token → hex lookup. STAGE_COLOR_OPTIONS above is only the curated
// picker; rows seeded by migrations (labels, other boards' stages, quick
// actions) use a wider palette — e.g. `blue-600`, `violet-600`,
// `neutral-500`, `pink-500` — and an unmapped token used to fall back to
// grey, which read as "the cards lost their colours". Tailwind palette
// values, hand-pinned.
const TOKEN_HEX: Record<string, string> = {
  // picker tokens
  'blue-500': '#3b82f6',
  'amber-500': '#f59e0b',
  'emerald-500': '#10b981',
  'orange-600': '#ea580c',
  'rose-600': '#e11d48',
  'violet-500': '#8b5cf6',
  'sky-500': '#0ea5e9',
  'slate-500': '#64748b',
  // wider palette used by seeds + admin-entered tokens
  'red-500': '#ef4444',
  'red-600': '#dc2626',
  'orange-500': '#f97316',
  'amber-400': '#fbbf24',
  'amber-600': '#d97706',
  'yellow-500': '#eab308',
  'lime-500': '#84cc16',
  'green-500': '#22c55e',
  'green-600': '#16a34a',
  'emerald-600': '#059669',
  'teal-500': '#14b8a6',
  'teal-600': '#0d9488',
  'cyan-500': '#06b6d4',
  'sky-600': '#0284c7',
  'blue-600': '#2563eb',
  'indigo-500': '#6366f1',
  'indigo-600': '#4f46e5',
  'violet-600': '#7c3aed',
  'purple-500': '#a855f7',
  'purple-600': '#9333ea',
  'fuchsia-500': '#d946ef',
  'pink-500': '#ec4899',
  'pink-600': '#db2777',
  'rose-500': '#f43f5e',
  'slate-400': '#94a3b8',
  'slate-600': '#475569',
  'gray-500': '#6b7280',
  'neutral-500': '#737373',
  'stone-500': '#78716c',
}

export function resolveStageColor(color: string): string {
  if (HEX_RE.test(color)) return color
  const hex = TOKEN_HEX[color]
  if (hex) return hex
  // Unknown token — fall back to neutral. Stays visible, never throws.
  return '#737373'
}
