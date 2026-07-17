// The embedded in-app Trengo conversation cockpit was retired at the
// operator's request (2026-07) — staff work in the real Trengo app instead.
// This route redirects to the Trengo gateway at /inbox. The cockpit component
// (InboxCockpit + panes) is retained in the repo (forward-only, §19) but is no
// longer rendered.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function ConversationsPage(): never {
  redirect('/inbox')
}
