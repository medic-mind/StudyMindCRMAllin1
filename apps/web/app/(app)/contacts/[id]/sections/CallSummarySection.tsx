// Call summary on a contact — the shared three-step wizard (email →
// text/WhatsApp → internal note). See
// apps/web/components/contact/call-summary-wizard.tsx for the flow.

'use client'

import { CallSummaryWizard } from '@/components/contact/call-summary-wizard'

interface Props {
  contactId: string
  contactDisplayName: string
}

export function CallSummarySection({ contactId, contactDisplayName }: Props) {
  return <CallSummaryWizard mode="contact" contactId={contactId} contactName={contactDisplayName} />
}
