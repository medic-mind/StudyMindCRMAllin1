// Call summary inside the card detail modal — the same three-step wizard as
// the contact page (email → text/WhatsApp → internal note) so both surfaces
// behave identically. The summary persists as a call_summary Interaction on
// the card's backing contact. See
// apps/web/components/contact/call-summary-wizard.tsx for the flow.

'use client'

import { CallSummaryWizard } from '@/components/contact/call-summary-wizard'
import { trpc } from '@/lib/trpc/client'

interface Props {
  cardId: string
  canWrite: boolean
}

export function CallSummarySection({ cardId, canWrite }: Props) {
  const cardQuery = trpc.card.get.useQuery({ id: cardId }, { enabled: canWrite })

  if (!canWrite) return null

  const contactId = cardQuery.data?.contactId ?? ''
  const contactName = cardQuery.data?.contactName ?? 'this contact'

  return (
    <section className="space-y-3">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Call summary
      </h3>
      {contactId ? (
        <CallSummaryWizard
          mode="card"
          cardId={cardId}
          contactId={contactId}
          contactName={contactName}
        />
      ) : (
        <p className="text-xs text-neutral-500">Loading…</p>
      )}
    </section>
  )
}
