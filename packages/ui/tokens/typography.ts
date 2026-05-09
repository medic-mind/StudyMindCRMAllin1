// Typography tokens. One sans family for product UI, one mono for
// code / IDs / amounts. Numerals are tabular wherever they line up
// vertically (CLAUDE.md §4): finance tables, reconciliation, ledgers.
// The `tnum` font feature is wired into `fontFeatureSettings.tabular`;
// consumers apply it via Tailwind utilities on finance + reconciliation
// surfaces.

export const typography = {
  fontFamily: {
    sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
    mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
  },
  /**
   * Font-feature presets. `tabular` enables `tnum` + `lnum` so digits
   * occupy fixed advance width — required for ledger columns to align.
   */
  fontFeatureSettings: {
    tabular: '"tnum" 1, "lnum" 1',
    default: 'normal',
  },
  fontSize: {
    xs: ['0.75rem', { lineHeight: '1rem' }],
    sm: ['0.875rem', { lineHeight: '1.25rem' }],
    base: ['1rem', { lineHeight: '1.5rem' }],
    lg: ['1.125rem', { lineHeight: '1.5rem' }],
    xl: ['1.25rem', { lineHeight: '1.75rem' }],
    '2xl': ['1.5rem', { lineHeight: '2rem' }],
    '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
  },
  letterSpacing: {
    tight: '-0.015em',
    normal: '0',
  },
  fontWeight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const

export type TypographyTokens = typeof typography
