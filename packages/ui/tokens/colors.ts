// Brand colour palette. Tailwind reads from these — never hard-code hex
// in components (CLAUDE.md §4). Token *names* are the contract; values may
// shift with design review.
//
// Use-case mapping:
// - `primary.*`     → trust, clinical calm. Default action surfaces, links,
//                     primary buttons. Body text uses neutral 700+ on white;
//                     primary 600/700 sit ≥ 4.5:1 on white for AA text.
// - `secondary.*`   → warm amber. Used sparingly to mark safeguarding
//                     banners and finance affordances that need attention
//                     without alarm (§4).
// - `neutral.*`     → page chrome, body text, dividers. Cool greys with
//                     high contrast at 700+. Body uses 800/900 on white
//                     surfaces (contrast ≥ 7:1, AAA-friendly).
// - `success/warning/danger/info` → status only.
//      success (emerald) = good outcome / settled
//      warning (amber)   = degraded but working / pending action
//      danger  (rose)    = action required (finance/safeguarding) / failed
//      info    (sky)     = neutral informational state
//
// No additional status colours land without a new token here.
//
// Each scale step has an intended use:
//   50  → tint backgrounds (banners, badges)
//   100 → soft surfaces (selected nav, badge backgrounds)
//   200 → borders on tint surfaces
//   300 → muted dividers on coloured surfaces
//   400 → disabled foregrounds, decorative
//   500 → mid-tone, focus rings
//   600 → default solid (button bg, link text)
//   700 → hover / pressed solid
//   800 → high-emphasis text on tint
//   900 → strongest text / headings on tint
//   950 → deepest, reserved for shadows / overlay text

export const colors = {
  // Primary blue: trust, clinical calm. Slightly cooler than a default
  // Tailwind blue to read as "clinical" rather than "playful".
  primary: {
    50: '#eff6ff',
    100: '#dbeafe',
    200: '#bfdbfe',
    300: '#93c5fd',
    400: '#60a5fa',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    800: '#1e40af',
    900: '#1e3a8a',
    950: '#172554',
  },
  // Warm secondary — amber. Used for safeguarding + finance attention
  // affordances. Carefully reserved; never default to secondary for
  // generic primary actions.
  secondary: {
    50: '#fffbeb',
    100: '#fef3c7',
    200: '#fde68a',
    300: '#fcd34d',
    400: '#fbbf24',
    500: '#f59e0b',
    600: '#d97706',
    700: '#b45309',
    800: '#92400e',
    900: '#78350f',
    950: '#451a03',
  },
  // Neutrals: cool slate. 700+ is the body-text band for ≥4.5:1 on white.
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
  // Status colours — emerald, amber, rose, sky.
  success: {
    50: '#ecfdf5',
    100: '#d1fae5',
    200: '#a7f3d0',
    500: '#10b981',
    600: '#059669',
    700: '#047857',
    900: '#064e3b',
  },
  warning: {
    50: '#fffbeb',
    100: '#fef3c7',
    200: '#fde68a',
    500: '#f59e0b',
    600: '#d97706',
    700: '#b45309',
    900: '#78350f',
  },
  danger: {
    50: '#fff1f2',
    100: '#ffe4e6',
    200: '#fecdd3',
    500: '#f43f5e',
    600: '#e11d48',
    700: '#be123c',
    900: '#881337',
  },
  info: {
    50: '#f0f9ff',
    100: '#e0f2fe',
    200: '#bae6fd',
    500: '#0ea5e9',
    600: '#0284c7',
    700: '#0369a1',
    900: '#0c4a6e',
  },
} as const

export type ColorTokens = typeof colors
