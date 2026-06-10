// Enquiry history on the contact page (ADR 0023 follow-up). Every web enquiry
// (first contact and each re-enquiry) is a lead_enquiry Interaction; this
// section lists them newest-first with what the person asked about and what
// they put in — site, form, subject, products, preferred call time, message.
// The pinned note only carries the latest summary; this is the full record.

'use client'

import { Badge } from '@/components/ui/badge'
import { trpc } from '@/lib/trpc/client'
import { formatLondon } from '@/lib/format/london-time'

export function EnquiriesSection({ contactId }: { contactId: string }) {
  const list = trpc.lead.enquiriesForContact.useQuery({ contactId, limit: 50 })
  const items = list.data ?? []

  if (list.isLoading) {
    return <p className="text-sm text-neutral-500">Loading enquiries…</p>
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        No web enquiries yet — when this person submits a form on one of the websites, every enquiry
        will be listed here with what they asked about.
      </p>
    )
  }

  return (
    <ol className="space-y-3">
      {items.map((e) => (
        <li key={e.id} className="rounded-lg border border-neutral-200 bg-neutral-50/50 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono tabular-nums text-neutral-500">
              {formatLondon(e.occurredAt, { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
            {e.reenquiry ? (
              <Badge tone="info">Re-enquiry</Badge>
            ) : (
              <Badge tone="success">First enquiry</Badge>
            )}
            {e.subject ? (
              <span className="rounded bg-primary-50 px-1.5 py-0.5 text-[11px] font-medium text-primary-800">
                {e.subject}
              </span>
            ) : null}
            {e.board === 'free_resources' ? (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">
                Free Resources
              </span>
            ) : null}
            {e.score != null ? (
              <span className="ml-auto font-mono text-[11px] tabular-nums text-neutral-500">
                score {e.score}
              </span>
            ) : null}
          </div>

          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            {e.site ? (
              <div>
                <dt className="text-neutral-500">Site</dt>
                <dd className="text-neutral-800">{e.site}</dd>
              </div>
            ) : null}
            {e.formTitle ? (
              <div>
                <dt className="text-neutral-500">Form</dt>
                <dd className="truncate text-neutral-800" title={e.formTitle}>
                  {e.formTitle}
                </dd>
              </div>
            ) : null}
            {e.preferredWhen ? (
              <div>
                <dt className="text-neutral-500">Preferred time</dt>
                <dd className="text-neutral-800">{e.preferredWhen} (UK)</dd>
              </div>
            ) : null}
            {e.categories.length > 0 ? (
              <div>
                <dt className="text-neutral-500">Interest</dt>
                <dd className="text-neutral-800">{e.categories.join(', ')}</dd>
              </div>
            ) : null}
            {e.productTags.length > 0 ? (
              <div>
                <dt className="text-neutral-500">Products</dt>
                <dd className="font-mono text-[11px] text-neutral-700">
                  {e.productTags.join(', ')}
                </dd>
              </div>
            ) : null}
            {e.phoneAsTyped ? (
              <div>
                <dt className="text-neutral-500">Phone (as typed)</dt>
                <dd className="text-neutral-800">{e.phoneAsTyped}</dd>
              </div>
            ) : null}
            {e.ip ? (
              <div>
                <dt className="text-neutral-500">IP / Country</dt>
                <dd className="font-mono text-[11px] text-neutral-700">
                  {e.ip}
                  {e.countryCode ? ` · ${e.countryCode}` : ''}
                </dd>
              </div>
            ) : null}
          </dl>

          {e.message ? (
            <p className="mt-2 rounded bg-white p-2 text-xs leading-snug text-neutral-700 ring-1 ring-inset ring-neutral-100">
              “{e.message}”
            </p>
          ) : null}
          {e.aiSummary ? (
            <p className="mt-2 text-xs italic text-neutral-600">{e.aiSummary}</p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
