// Inline invoice-PDF preview. The PDF is fetched through the CRM's own backend
// proxy (which adds the Authorization header server-side — the browser can't,
// and the sk_live_ key must never reach it), turned into a blob URL, and shown
// in an iframe. We frame a `blob:` (not the proxy route) because the app sends
// X-Frame-Options: DENY + CSP frame-ancestors 'none' on its own responses to
// stop being framed — a blob carries no such headers, so it renders, while
// `frame-src 'self' blob:` (csp.ts) admits it. Byte-identical to what the
// client receives (ADR 0036).

'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'

export function invoicePdfUrl(invoicingId: string, download = false): string {
  const base = `/api/internal/invoicing/invoices/${encodeURIComponent(invoicingId)}/pdf`
  return download ? `${base}?download=1` : base
}

export function InvoicePdfPreview({
  invoicingId,
  invoiceNumber,
  onClose,
}: {
  invoicingId: string | null
  invoiceNumber?: string | null
  onClose: () => void
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!invoicingId) {
      setBlobUrl(null)
      return
    }
    let cancelled = false
    let createdUrl: string | null = null
    setLoading(true)
    setError(null)
    setBlobUrl(null)

    fetch(invoicePdfUrl(invoicingId), { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load the PDF (${res.status}).`)
        const blob = await res.blob()
        if (cancelled) return
        createdUrl = URL.createObjectURL(blob)
        setBlobUrl(createdUrl)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the PDF.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [invoicingId])

  return (
    <Modal
      open={invoicingId !== null}
      onClose={onClose}
      size="xl"
      title={`Invoice PDF${invoiceNumber ? ` — ${invoiceNumber}` : ''}`}
      footer={
        invoicingId ? (
          <>
            <a
              href={invoicePdfUrl(invoicingId, true)}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-primary-700 hover:underline"
            >
              Download
            </a>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        ) : null
      }
    >
      <div className="min-h-[60vh]">
        {loading && <p className="p-6 text-sm text-neutral-500">Loading PDF…</p>}
        {error && <p className="p-6 text-sm text-red-600">{error}</p>}
        {blobUrl && (
          <iframe title="Invoice PDF preview" src={blobUrl} className="h-[72vh] w-full border-0" />
        )}
      </div>
    </Modal>
  )
}
