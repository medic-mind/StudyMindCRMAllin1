// Brand colour palette. Tailwind reads from these — never hard-code hex
// in components (CLAUDE.md §4). Placeholder pending design review; the
// token *names* are the contract, the values may shift.
//
// Use-case mapping:
// - `primary.*`     → trust, clinical calm. Default action surfaces.
// - `secondary.*`   → warm accent, used sparingly. Marks safeguarding
//                     banners and finance affordances that need attention
//                     without alarm.
// - `neutral.*`     → page chrome, body text, dividers. Body text uses
//                     `neutral.700+` against `neutral.0`/`neutral.50` to
//                     keep contrast ≥ 4.5:1 (WCAG 2.2 AA, CLAUDE.md §28).
// - `success/warning/danger/info` → status only. Mapping: success = good
//                     outcome, warning = degraded but working,
//                     danger = action required (finance or safeguarding),
//                     info = neutral state.
//
// No additional status colours land without a new token here.

export const colors = {
  // Primary blue: trust, clinical calm.
  primary: {
    50: '#eef5ff',
    100: '#d9e8ff',
    200: '#b9d5ff',
    300: '#8ab8ff',
    400: '#5494ff',
    500: '#2b71f5',
    600: '#1957db',
    700: '#1645b1',
    800: '#143b8c',
    900: '#13346f',
    950: '#0c1f47',
  },
  // Warm secondary — used sparingly to mark safeguarding and finance affordances.
  secondary: {
    50: '#fff7ed',
    100: '#ffeed4',
    200: '#fed8a8',
    300: '#fdbb71',
    400: '#fb9438',
    500: '#f97612',
    600: '#ea5b08',
    700: '#c24309',
    800: '#9a3610',
    900: '#7c2e11',
    950: '#431505',
  },
  neutral: {
    0: '#ffffff',
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
    950: '#020617',
  },
  // Status colours.
  success: { 500: '#10b981', 600: '#059669', 100: '#d1fae5' },
  warning: { 500: '#f59e0b', 600: '#d97706', 100: '#fef3c7' },
  danger: { 500: '#ef4444', 600: '#dc2626', 100: '#fee2e2' },
  info: { 500: '#3b82f6', 600: '#2563eb', 100: '#dbeafe' },
} as const

export type ColorTokens = typeof colors
