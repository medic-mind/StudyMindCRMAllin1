// Rich-HTML email reader (ADR 0041). Renders the message's real body in a
// sandboxed same-origin iframe served by `/api/internal/mail-render/:id` — that
// route carries its OWN relaxed CSP so remote images + inline styles render
// (a `srcdoc` iframe would inherit the app's strict CSP and block both). The
// route is access-gated per contact, so it is safe to embed from `/mail` AND
// the contact page. A toggle falls back to the plain-text preview.

'use client'

import { useState } from 'react'

export function EmailHtmlBody({
  interactionId,
  text,
  height = 460,
}: {
  interactionId: string
  text: string
  height?: number
}) {
  const [showHtml, setShowHtml] = useState(true)
  return (
    <div>
      {showHtml ? (
        <iframe
          title="Email message"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          src={`/api/internal/mail-render/${interactionId}`}
          className="w-full rounded bg-white"
          style={{ height, border: 0 }}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-neutral-900">
          {text || '(no content)'}
        </p>
      )}
      <button
        type="button"
        onClick={() => setShowHtml((v) => !v)}
        className="mt-1 text-[11px] font-medium text-neutral-400 hover:text-neutral-600"
      >
        {showHtml ? 'View plain text' : 'View formatted'}
      </button>
    </div>
  )
}
