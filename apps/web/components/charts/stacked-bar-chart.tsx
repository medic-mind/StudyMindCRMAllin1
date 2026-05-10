// Hand-rolled stacked bar chart. RSC — pure SVG, no client interactivity.
// CLAUDE.md §28 — chart includes <title>, <desc>, and a sr-only data
// summary table so screen readers get the same numbers visual users see.

import type { AxisHints, Series } from './types'

interface Props {
  /** All series share the same x-axis labels. */
  xLabels: string[]
  series: Series[]
  height?: number
  width?: number
  axis?: AxisHints
  title: string
  description?: string
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 } as const

export function StackedBarChart({
  xLabels,
  series,
  height = 220,
  width = 720,
  axis,
  title,
  description,
}: Props) {
  const innerW = width - PADDING.left - PADDING.right
  const innerH = height - PADDING.top - PADDING.bottom

  const stacks = xLabels.map((_, i) =>
    series.reduce((acc, s) => acc + (s.values[i]?.y ?? 0), 0),
  )
  const maxStack = Math.max(1, ...stacks)
  const yTicks = niceTicks(maxStack, 4)
  const yMax = yTicks[yTicks.length - 1] ?? maxStack
  const fmt = axis?.yFormat ?? ((n) => String(n))

  const gap = 6
  const barW = xLabels.length === 0 ? 0 : Math.max(2, innerW / xLabels.length - gap)

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={ariaIds(title)}
        className="h-auto w-full"
      >
        <title id={`${slug(title)}-title`}>{title}</title>
        {description ? <desc id={`${slug(title)}-desc`}>{description}</desc> : null}

        {/* Y axis grid + labels */}
        {yTicks.map((t, i) => {
          const y = PADDING.top + innerH - (t / yMax) * innerH
          return (
            <g key={i}>
              <line
                x1={PADDING.left}
                x2={PADDING.left + innerW}
                y1={y}
                y2={y}
                stroke="#e5e7eb"
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 6}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-neutral-500 font-mono text-[10px] tabular-nums"
              >
                {fmt(t)}
              </text>
            </g>
          )
        })}

        {/* Bars */}
        {xLabels.map((label, i) => {
          let runningY = PADDING.top + innerH
          const x = PADDING.left + i * (barW + gap) + gap / 2
          return (
            <g key={i}>
              {series.map((s) => {
                const v = s.values[i]?.y ?? 0
                const segH = (v / yMax) * innerH
                runningY -= segH
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={runningY}
                    width={barW}
                    height={segH}
                    fill={s.color}
                    rx={1}
                  >
                    <title>
                      {s.label} · {label} · {fmt(v)}
                    </title>
                  </rect>
                )
              })}
              <text
                x={x + barW / 2}
                y={PADDING.top + innerH + 16}
                textAnchor="middle"
                className="fill-neutral-500 font-mono text-[10px] tabular-nums"
              >
                {label}
              </text>
            </g>
          )
        })}

        {/* X axis line */}
        <line
          x1={PADDING.left}
          x2={PADDING.left + innerW}
          y1={PADDING.top + innerH}
          y2={PADDING.top + innerH}
          stroke="#9ca3af"
          strokeWidth={1}
        />
      </svg>

      <Legend series={series} />
      <ScreenReaderSummary
        title={title}
        xLabels={xLabels}
        series={series}
        fmt={fmt}
      />
    </figure>
  )
}

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-700">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: s.color }}
          />
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  )
}

function ScreenReaderSummary({
  title,
  xLabels,
  series,
  fmt,
}: {
  title: string
  xLabels: string[]
  series: Series[]
  fmt: (n: number) => string
}) {
  return (
    <table className="sr-only">
      <caption>{title} — data table</caption>
      <thead>
        <tr>
          <th>Period</th>
          {series.map((s) => (
            <th key={s.key}>{s.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {xLabels.map((x, i) => (
          <tr key={i}>
            <th scope="row">{x}</th>
            {series.map((s) => (
              <td key={s.key}>{fmt(s.values[i]?.y ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function niceTicks(max: number, count: number): number[] {
  const step = niceStep(max / count)
  const ticks: number[] = []
  for (let v = 0; v <= max + step; v += step) ticks.push(Math.round(v))
  return ticks
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / exp
  if (norm < 1.5) return exp
  if (norm < 3) return 2 * exp
  if (norm < 7) return 5 * exp
  return 10 * exp
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function ariaIds(title: string): string {
  return `${slug(title)}-title ${slug(title)}-desc`
}
