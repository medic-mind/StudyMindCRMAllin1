// Email HTML preparation for the reading pane (ADR 0041).
//
// The reading pane renders this inside a LOCKED, opaque-origin sandboxed iframe
// (no allow-scripts, no allow-same-origin), which is the primary XSS control —
// scripts can never execute and the frame can't touch the app. This pass is
// defense-in-depth + hygiene: it strips the constructs that could execute or
// redirect/exfiltrate, and caps the size so a pathological body can't bloat the
// row. Inline styles and images are intentionally KEPT so the message looks
// exactly as it does in Gmail.

/** Bodies larger than this fall back to the plaintext rendering. */
export const MAX_EMAIL_HTML_BYTES = 512 * 1024

/**
 * Remove script/active/redirecting constructs and inline event handlers while
 * preserving the visual HTML (inline styles, tables, images, links).
 */
export function sanitizeEmailHtml(html: string): string {
  return html
    // <script>…</script> and self-closing/standalone script tags.
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*script\b[^>]*>/gi, '')
    // Active / redirecting / remote-resource elements. <style> is kept.
    .replace(/<\s*(iframe|object|embed|applet)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(iframe|object|embed|applet|base|meta|link)\b[^>]*>/gi, '')
    // Inline event handlers: on*="…" / on*='…' / on*=value.
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    // javascript: URLs in href/src/etc.
    .replace(/(href|src|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2')
}

/**
 * Sanitise + size-gate an email HTML body for storage/render. Returns null when
 * there is no usable HTML (empty, or over the byte cap), so callers fall back
 * to the plaintext body.
 */
export function prepareEmailHtml(html: string | null | undefined): string | null {
  if (!html) return null
  if (Buffer.byteLength(html, 'utf8') > MAX_EMAIL_HTML_BYTES) return null
  const cleaned = sanitizeEmailHtml(html).trim()
  return cleaned.length > 0 ? cleaned : null
}
