// Shared types and brand-token-aware palette for the dashboard charts.
//
// We hand-roll the chart components in plain SVG to stay dep-free
// (CLAUDE.md §3 — no new deps without an ADR). The primitives are
// intentionally minimal: the goal is a readable visual summary on top of
// the existing tables, not a full charting library. CLAUDE.md §28 — every
// chart pairs the SVG with a screen-reader summary.

export interface SeriesPoint {
  x: string
  y: number
}

export interface Series {
  key: string
  label: string
  color: string
  values: SeriesPoint[]
}

/**
 * Brand-token-driven palette. Order chosen to be accessible side-by-side
 * (sequential blue scale plus warm amber for refunded/danger). When you
 * need more than five categories, fall back to neutral first.
 */
export const CHART_PALETTE = [
  '#1d4ed8', // primary-700
  '#2563eb', // primary-600
  '#60a5fa', // primary-400
  '#f59e0b', // amber-500 — warm secondary
  '#10b981', // emerald-500 — success
  '#ef4444', // red-500 — danger
  '#6b7280', // neutral-500
] as const

export interface AxisHints {
  yLabel?: string
  yFormat?: (n: number) => string
  xLabel?: string
}
