// Deep links to a single conversation now open the cockpit focused on that
// conversation, rather than a separate stacked page — the list stays pinned and
// the contact/ticket context is right there, the way Trengo works. ADR 0020.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function ConversationDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/inbox/conversations?c=${encodeURIComponent(id)}`)
}
