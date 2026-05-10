// Single-series histogram. RSC. Used for the churn-score distribution
// on /reports/retention.

interface Props {
  /**
   * One bucket per element. Index 0 is the lowest range (e.g. churn score
   * 0.0–0.1) and index N-1 is the highest. The labels[] array must have
   * the same length as buckets[].
   */
  buckets: number[]
  labels: string[]
  height?: number
  width?: number
  title: string
  description?: string
  /** Threshold above which a bucket is shown in warn-amber. */
  warnThresholdIndex?: number
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 } as const

export function Histogram({
  buckets,
  labels,
  height = 200,
  width = 600,
  title,
  description,
  warnThresholdIndex,
}: Props) {
  const innerW = width - PADDING.left - PADDING.right
  const innerH = height - PADDING.top - PADDING.bottom
  const max = Math.max(1, ...buckets)
  const yTicks = niceTicks(max, 4)
  const yMax = yTicks[yTicks.length - 1] ?? max
  const gap = 6
  const barW = buckets.length === 0 ? 0 : Math.max(2, innerW / buckets.length - gap)

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
                {t}
              </text>
            </g>
          )
        })}

        {buckets.map((v, i) => {
          const h = (v / yMax) * innerH
          const x = PADDING.left + i * (barW + gap) + gap / 2
          const y = PADDING.top + innerH - h
          const fill =
            warnThresholdIndex != null && i >= warnThresholdIndex
              ? '#f59e0b'
              : '#2563eb'
          return (
            <g key={i}>
              <rect x={x} y={y} width={barW} height={h} fill={fill} rx={1}>
                <title>
                  {labels[i]}: {v}
                </title>
              </rect>
              <text
                x={x + barW / 2}
                y={PADDING.top + innerH + 16}
                textAnchor="middle"
                className="fill-neutral-500 font-mono text-[10px] tabular-nums"
              >
                {labels[i]}
              </text>
            </g>
          )
        })}

        <line
          x1={PADDING.left}
          x2={PADDING.left + innerW}
          y1={PADDING.top + innerH}
          y2={PADDING.top + innerH}
          stroke="#9ca3af"
          strokeWidth={1}
        />
      </svg>

      <table className="sr-only">
        <caption>{title} — data table</caption>
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((v, i) => (
            <tr key={i}>
              <th scope="row">{labels[i]}</th>
              <td>{v}</td>
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
