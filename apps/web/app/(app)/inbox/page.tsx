// The customer Inbox. The legacy raw inbound-message list that used to live
// here was collapsed into the head-backed conversation view (ADR 0020) — the
// two were the same Trengo data from different layers. `/inbox` now redirects
// to that single canonical list so there is one customer inbox, not two.

import { redirect } from 'next/navigation'

export default function InboxIndexPage(): never {
  redirect('/inbox/conversations')
}
