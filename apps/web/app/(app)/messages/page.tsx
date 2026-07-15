// Team chat was removed from the product at the operator's request (2026-07).
// The route redirects to the customer inbox; the chat backend (ADR 0022) is
// retained forward-only should the section ever return.

import { redirect } from 'next/navigation'

export default function MessagesPage(): never {
  redirect('/inbox/conversations')
}
