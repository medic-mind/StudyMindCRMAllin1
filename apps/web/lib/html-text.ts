// Small HTML ⇆ plain-text helpers for the rich-text email editor. Client-only
// (uses the DOM). Lets us store both an HTML body and a sensible plain-text
// fallback from one friendly editor, and seed the editor from an existing
// plain-text template.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Plain text → simple HTML (escape + line breaks) for seeding the editor. */
export function textToHtml(text: string): string {
  if (!text) return ''
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

/** Rich HTML → readable plain text (for the text/plain email part). */
export function htmlToPlainText(html: string): string {
  if (!html) return ''
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|li|h[1-6]|ul|ol)\s*>/gi, '\n')
  const el = document.createElement('div')
  el.innerHTML = withBreaks
  return (el.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}
