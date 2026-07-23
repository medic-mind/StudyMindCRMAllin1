// Client-side board card search. Filters the already-loaded cards so staff can
// find a card by typing in the board's own search box instead of the browser's
// Ctrl+F (ops request, 2026-07). Matches contact name / email / phone, company,
// subject, enquiry types, labels, assignee and the card note. Phone numbers
// match in any format via the shared `phoneSearchDigitRuns` (the same helper the
// global ⌘K search + Contacts table use, §29). Multi-word queries are AND — all
// terms must appear — so "shamin ucat" narrows on both.
//
// Pure + dependency-light so it's unit-tested and reused by BOTH the kanban and
// the list view (they stay behaviourally identical, CLAUDE.md §26).

import { phoneSearchDigitRuns } from '@studymind/core/contact/phone-search'

export interface SearchableCard {
  contactName: string
  contactEmail?: string | null
  contactPhone?: string | null
  company?: { name: string } | null
  description?: string | null
  subject?: { name: string } | null
  enquiryTypes?: ReadonlyArray<string>
  labels: ReadonlyArray<{ name: string }>
  assigneeName?: string | null
  assigneeEmail?: string | null
}

function textHaystack(card: SearchableCard): string {
  return [
    card.contactName,
    card.contactEmail,
    card.contactPhone,
    card.company?.name,
    card.subject?.name,
    ...(card.enquiryTypes ?? []),
    ...card.labels.map((l) => l.name),
    card.assigneeName,
    card.assigneeEmail,
    card.description,
  ]
    .filter((v): v is string => Boolean(v))
    .join(' • ')
    .toLowerCase()
}

/** Does this card match the search query? Empty query matches everything. */
export function cardMatchesQuery(card: SearchableCard, rawQuery: string): boolean {
  const q = rawQuery.trim()
  if (!q) return true

  // A phone-shaped query matches ONLY the card's phone digits (in any format),
  // never text — so "7852" finds the number, not a stray digit run in a name.
  const runs = phoneSearchDigitRuns(q)
  if (runs.length > 0) {
    const phoneDigits = (card.contactPhone ?? '').replace(/\D/gu, '')
    return phoneDigits.length > 0 && runs.some((r) => phoneDigits.includes(r))
  }

  // Otherwise every whitespace-separated term must appear somewhere (AND).
  const hay = textHaystack(card)
  return q
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((term) => hay.includes(term))
}

/** Filter a card list by the query, preserving order. */
export function filterCardsByQuery<T extends SearchableCard>(
  cards: ReadonlyArray<T>,
  query: string,
): T[] {
  if (!query.trim()) return [...cards]
  return cards.filter((c) => cardMatchesQuery(c, query))
}
