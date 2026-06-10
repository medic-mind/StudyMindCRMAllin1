'use client'

// Interactive multi-series line chart for the Aircall report workspace.
// Adds what the static RSC LineChart can't: a hover/keyboard crosshair with a
// tooltip showing every series at the hovered point, and an area wash under
// the first series. Dependency-free SVG (CLAUDE.md §3); keyboard reachable +
// sr-only data table per §28. Other report pages keep the RSC LineChart.

import { useId, useMemo, useRef, useState } from 'react'

import type { AxisHints, Series } from './types'

interface Props {
  xLabels: string[]
  series: Series[]
  height?: number
  width?: number
  axis?: AxisHints
  title: string
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 } as const

export function InteractiveLineChart({
  xLabels,
  series,
  height = 240,
  width = 720,
  axis,
  title,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId()

  const innerW = width - PADDING.left - PADDING.right
  const innerH = height - PADDING.top - PADDING.bottom
  const fmt = axis?.yFormat ?? ((n: number) => String(n))

  const { yTicks, yMax, xStep } = useMemo(() => {
    const allValues = series.flatMap((s) => s.values.map((v) => v.y))
    const maxY = Math.max(1, ...allValues)
    const ticks = niceTicks(maxY, 4)
    return {
      yTicks: ticks,
      yMax: ticks[ticks.length - 1] ?? maxY,
      xStep: xLabels.length <= 1 ? 0 : innerW / (xLabels.length - 1),
    }
  }, [series, xLabels.length, innerW])

  const xAt = (i: number) => PADDING.left + i * xStep
  const yAt = (v: number) => PADDING.top + innerH - (v / yMax) * innerH

  // Thin x labels to ~12 so a month of days never smears.
  const labelStep = Math.max(1, Math.ceil(xLabels.length / 12))
  const lastX = xLabels.length - 1

  function indexFromClientX(clientX: number): number | null {
    const svg = svgRef.current
    if (!svg || xLabels.length === 0) return null
    const rect = svg.getBoundingClientRect()
    const px = ((clientX - rect.left) / rect.width) * width
    const i = Math.round((px - PADDING.left) / (xStep || 1))
    return Math.max(0, Math.min(lastX, i))
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setHover((h) => Math.min(lastX, (h ?? -1) + 1))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setHover((h) => Math.max(0, (h ?? xLabels.length) - 1))
    } else if (e.key === 'Escape') {
      setHover(null)
    }
  }

  const first = series[0]
  const areaPath =
    first && first.values.length > 1
      ? `M ${xAt(0)},${yAt(first.values[0]?.y ?? 0)} ` +
        first.values.map((v, i) => `L ${xAt(i)},${yAt(v.y)}`).join(' ') +
        ` L ${xAt(first.values.length - 1)},${PADDING.top + innerH} L ${xAt(0)},${PADDING.top + innerH} Z`
      : null

  return (
    <figure className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title}
        tabIndex={0}
        className="h-auto w-full cursor-crosshair touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        onPointerMove={(e) => setHover(indexFromClientX(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={first?.color ?? '#9333ea'} stopOpacity={0.14} />
            <stop offset="100%" stopColor={first?.color ?? '#9333ea'} stopOpacity={0.01} />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={PADDING.left}
              x2={PADDING.left + innerW}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 6}
              y={yAt(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-neutral-500 font-mono text-[10px] tabular-nums"
            >
              {fmt(t)}
            </text>
          </g>
        ))}

        {areaPath ? <path d={areaPath} fill={`url(#${uid}-area)`} /> : null}

        {series.map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={s.values.map((v, i) => `${xAt(i)},${yAt(v.y)}`).join(' ')}
          />
        ))}

        {/* Crosshair + highlighted points at the hovered index. */}
        {hover != null && xLabels[hover] != null ? (
          <g>
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={PADDING.top}
              y2={PADDING.top + innerH}
              stroke="#a3a3a3"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            {series.map((s) => {
              const v = s.values[hover]
              if (!v) return null
              return (
                <circle
                  key={s.key}
                  cx={xAt(hover)}
                  cy={yAt(v.y)}
                  r={3.5}
                  fill="#fff"
                  stroke={s.color}
                  strokeWidth={2}
                />
              )
            })}
          </g>
        ) : null}

        {xLabels.map((label, i) =>
          i % labelStep === 0 || i === lastX ? (
            <text
              key={i}
              x={xAt(i)}
              y={PADDING.top + innerH + 16}
              textAnchor={i === lastX ? 'end' : i === 0 ? 'start' : 'middle'}
              className="fill-neutral-500 font-mono text-[10px] tabular-nums"
            >
              {label}
            </text>
          ) : null,
        )}
        <line
          x1={PADDING.left}
          x2={PADDING.left + innerW}
          y1={PADDING.top + innerH}
          y2={PADDING.top + innerH}
          stroke="#9ca3af"
          strokeWidth={1}
        />
      </svg>

      {/* Tooltip — positioned over the hovered index, clamped to the figure. */}
      {hover != null && xLabels[hover] != null ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[8rem] rounded-lg border border-neutral-200 bg-white/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: `min(max(${((xAt(hover) / width) * 100).toFixed(2)}% - 4rem, 0%), calc(100% - 9rem))`,
          }}
          role="status"
        >
          <p className="mb-1 font-semibold text-neutral-900">{xLabels[hover]}</p>
          <ul className="space-y-0.5">
            {series.map((s) => (
              <li key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-neutral-600">
                  <span
                    aria-hidden="true"
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.label}
                </span>
                <span className="font-mono tabular-nums text-neutral-900">
                  {fmt(s.values[hover]?.y ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
    </figure>
  )
}

function niceTicks(max: number, count: number): number[] {
  const step = niceStep(max / count)
  const ticks: number[] = []
  for (let v = 0; v <= max + step; v += step) ticks.push(Math.round(v))
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
