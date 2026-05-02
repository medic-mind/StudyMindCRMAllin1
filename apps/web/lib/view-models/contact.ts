// Contact view-models. Constructed in RSC, never expose raw rows to the client.
// See CLAUDE.md Section 26.

export interface ContactListItem {
  id: string
  displayName: string
  emailMasked: string | null
  phoneE164: string | null
}

export interface ContactDetailViewModel {
  id: string
  displayName: string
  email: string | null
  phoneE164: string | null
  isMinor: boolean
  hasSafeguardingFlag: boolean
}
