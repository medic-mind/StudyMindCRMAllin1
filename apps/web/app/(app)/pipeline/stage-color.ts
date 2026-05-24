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

export function resolveStageColor(color: string): string {
  if (HEX_RE.test(color)) return color
  const match = STAGE_COLOR_OPTIONS.find((o) => o.token === color)
  if (match) return match.hex
  // Unknown token — fall back to neutral. Stays visible, never throws.
  return '#737373'
}
