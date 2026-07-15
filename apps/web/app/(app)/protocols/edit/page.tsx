// Retired with the in-app knowledge base (2026-07) — Crib is the source of
// truth. Redirects to the gateway page.

import { redirect } from 'next/navigation'

export default function RetiredKnowledgePage(): never {
  redirect('/protocols')
}
