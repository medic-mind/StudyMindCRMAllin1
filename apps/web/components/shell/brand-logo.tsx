// StudyMind brand mark — a clean blue rounded-square tile with a white "S"
// monogram, matching the primary-blue brand intent (§4). Authored as an inline
// SVG so it scales crisply at any size and needs no asset pipeline (the previous
// hand-drawn brain glyph went rough at small sizes). If marketing supplies an
// exact PNG, drop it at apps/web/public/logo.png and swap <BrandLogo> for
// <img>. CLAUDE.md §4.

interface Props {
  size?: number
  className?: string
  /** Render just the mark (no wordmark). */
  markOnly?: boolean
  /** Wordmark colour — defaults to current text colour. */
  wordmarkClassName?: string
  /**
   * When set, render the uploaded custom logo (served from
   * /api/branding/logo) in place of the inline SVG mark. The number is the
   * logo version (epoch millis) used to cache-bust. Null/undefined → SVG.
   */
  customLogoVersion?: number | null
}

export function BrandLogo({
  size = 28,
  className,
  markOnly = false,
  wordmarkClassName = 'text-neutral-900',
  customLogoVersion = null,
}: Props) {
  if (customLogoVersion != null) {
    // Render the uploaded logo as a normal <img> with an explicit height so
    // the browser reserves the right space before the image loads (no flash to
    // natural size) and scales the width by aspect ratio. object-contain + a
    // max-width stop a wide wordmark from stretching the top bar. CLAUDE.md §4.
    return (
      <img
        src={`/api/branding/logo?v=${customLogoVersion}`}
        alt="StudyMind"
        className={`block w-auto shrink-0 object-contain ${className ?? ''}`}
        style={{ height: size, maxHeight: size, maxWidth: size * 7 }}
      />
    )
  }
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        role="img"
        aria-label="StudyMind"
        className="shrink-0"
      >
        <defs>
          <linearGradient id="sm-brand" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="60" height="60" rx="17" fill="url(#sm-brand)" />
        <text
          x="32"
          y="33"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
          fontSize="38"
          fontWeight="700"
          fill="#ffffff"
        >
          S
        </text>
      </svg>
      {markOnly ? null : (
        <span className={`text-sm font-semibold tracking-tight ${wordmarkClassName}`}>
          StudyMind <span className="font-light opacity-70">CRM</span>
        </span>
      )}
    </span>
  )
}

