// StudyMind brand mark — a violet→magenta gradient disc with a head + brain
// glyph, matching the logo. Authored as an inline SVG so it scales crisply
// and needs no asset pipeline. If the marketing team supplies the exact PNG,
// drop it at apps/web/public/logo.png and swap <BrandLogo> for <img>.
// CLAUDE.md §4 (brand identity).

interface Props {
  size?: number
  className?: string
  /** Render just the disc + glyph (no wordmark). */
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
            <stop offset="0%" stopColor="#6d28d9" />
            <stop offset="55%" stopColor="#9333ea" />
            <stop offset="100%" stopColor="#a21caf" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="31" fill="url(#sm-brand)" />
        {/* Head profile + brain, simplified, in white strokes */}
        <g
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 46 V40 c-3 0-5-2-5-6 0-3 2-5 2-8 0-9 8-15 17-15 9 0 15 6 15 14 0 6-4 9-4 14 v7 h-9 v-5 h-7 v5 z" />
          <path d="M26 22 c-3 0-5 2-5 5 0 1 .5 2 1 3 -1 1-1 3 0 4 1 1 3 1 4 0" />
          <path d="M26 22 c2-2 6-2 8 0 2-1 5-1 6 1 2 0 3 2 3 4 0 2-1 3-2 4 1 2-1 4-3 4 -2 1-5 0-6-2" />
          <path d="M30 21 v18" />
        </g>
      </svg>
      {markOnly ? null : (
        <span className={`text-sm font-semibold tracking-tight ${wordmarkClassName}`}>
          StudyMind <span className="font-normal opacity-70">CRM</span>
        </span>
      )}
    </span>
  )
}
