// Hand-rolled multi-series line chart. RSC — pure SVG.
// CLAUDE.md §28 — sr-only data table mirrors the visual.

import type { AxisHints, Series } from './types'

interface Props {
  xLabels: string[]
  series: Series[]
  height?: number
  width?: number
  axis?: AxisHints
  title: string
  description?: string
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 } as const

export function LineChart({
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

  const allValues = series.flatMap((s) => s.values.map((v) => v.y))
  const maxY = Math.max(1, ...allValues)
  const yTicks = niceTicks(maxY, 4)
  const yMax = yTicks[yTicks.length - 1] ?? maxY
  const fmt = axis?.yFormat ?? ((n) => String(n))

  const xStep = xLabels.length <= 1 ? 0 : innerW / (xLabels.length - 1)

  // Thin the x-axis labels so they never overlap: show at most ~12, evenly
  // spaced, always including the last. (A month of daily labels otherwise
  // collides into an unreadable smear.) The sr-only table keeps every point.
  const maxXLabels = 12
  const labelStep = Math.max(1, Math.ceil(xLabels.length / maxXLabels))
  const lastX = xLabels.length - 1
  const showLabel = (i: number) => i % labelStep === 0 || i === lastX
  // With many points a dot per day is noise — keep dots only on points that
  // actually carry a value, so activity still reads at a glance.
  const denseData = xLabels.length > 16

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

        {/* Lines */}
        {series.map((s) => {
          const points = s.values
            .map((v, i) => {
              const x = PADDING.left + i * xStep
              const y = PADDING.top + innerH - (v.y / yMax) * innerH
              return `${x},${y}`
            })
            .join(' ')
          return (
            <g key={s.key}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points}
              />
              {s.values.map((v, i) => {
                // Drop the zero points on dense (e.g. monthly) charts so the
                // line stays clean; sparse charts keep every marker.
                if (denseData && v.y === 0) return null
                const x = PADDING.left + i * xStep
                const y = PADDING.top + innerH - (v.y / yMax) * innerH
                return (
                  <circle key={i} cx={x} cy={y} r={2.5} fill={s.color}>
                    <title>
                      {s.label} · {xLabels[i]} · {fmt(v.y)}
                    </title>
                  </circle>
                )
              })}
            </g>
          )
        })}

        {/* X axis labels — thinned to avoid overlap */}
        {xLabels.map((label, i) =>
          showLabel(i) ? (
            <text
              key={i}
              x={PADDING.left + i * xStep}
              y={PADDING.top + innerH + 16}
              textAnchor={i === lastX ? 'end' : i === 0 ? 'start' : 'middle'}
              className="fill-neutral-500 font-mono text-[10px] tabular-nums"
            >
              {label}
            </text>
          ) : null,
        )}

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
            className="inline-block h-0.5 w-3"
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
  // A fractional step (e.g. 0.5 over a 0–2 range) rounds adjacent values to the
  // same integer; dedupe so we don't draw "1, 1, 2, 2" overlapping y-labels.
  return [...new Set(ticks)]
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
