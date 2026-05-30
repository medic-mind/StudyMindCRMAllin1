// Domain adapter: maps CRM records to invoicing-platform payloads, and the
// other direction's category/status decisions. Pure functions, no I/O — the
// outbound/sync modules supply the data and persist the result.
//
// Category mapping (CLAUDE.md task):
//   CRM school          → category 'b2b'      + client_type 'school'
//   CRM partnership     → category 'b2b'      + client_type 'uk_b2b'
//   CRM B2C individual  → category 'b2c'      + client_type 'uk_b2b'
//   CRM AP/council      → category 'alt_provision'

import type { CustomerWritePayload } from './client'
import { toMajor } from './types'

/** A CRM BusinessAccount projected to the fields the adapter needs. */
export interface CrmBusinessAccount {
  kind: 'school' | 'partnership'
  name: string
  contactEmail: string | null
  contactPhone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postcode: string | null
  country: string | null
  notes: string | null
  /** Heuristic: an AP/council account is a partnership tagged accordingly.
   *  Callers may set this explicitly to route to alt_provision. */
  isAlternativeProvision?: boolean
}

/** A CRM Contact projected to the fields the adapter needs (B2C path). */
export interface CrmContact {
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postcode: string | null
  country: string | null
}

/** Writable category values the API accepts (no `unknown`). */
export type WritableCategory = 'b2b' | 'b2c' | 'alt_provision'

/** Decide the invoicing category for a CRM BusinessAccount. */
export function categoryForBusinessAccount(
  account: Pick<CrmBusinessAccount, 'kind' | 'isAlternativeProvision'>,
): WritableCategory {
  if (account.isAlternativeProvision) return 'alt_provision'
  // Both schools and partnerships are B2B from the invoicing platform's POV.
  return 'b2b'
}

function joinAddress(parts: Array<string | null>): string | undefined {
  const joined = parts.filter((p) => p && p.trim()).join(', ')
  return joined || undefined
}

/** Build the customer create/update payload for a CRM BusinessAccount. */
export function businessAccountToCustomerPayload(
  account: CrmBusinessAccount,
): CustomerWritePayload {
  return {
    company_name: account.name,
    category: categoryForBusinessAccount(account),
    contact_email: account.contactEmail ?? undefined,
    phone: account.contactPhone ?? undefined,
    address: joinAddress([
      account.addressLine1,
      account.addressLine2,
      account.city,
      account.postcode,
    ]),
    country: account.country ?? undefined,
    notes: account.notes ?? undefined,
  }
}

/** Build the customer payload for a CRM B2C Contact. company_name is the
 *  person's name for B2C, per the API contract. */
export function contactToCustomerPayload(contact: CrmContact): CustomerWritePayload {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
  return {
    company_name: name || contact.email || 'Unnamed contact',
    category: 'b2c',
    contact_name: name || undefined,
    contact_email: contact.email ?? undefined,
    phone: contact.phoneE164 ?? undefined,
    address: joinAddress([
      contact.addressLine1,
      contact.addressLine2,
      contact.city,
      contact.postcode,
    ]),
    country: contact.country ?? undefined,
  }
}

/** A CRM-side line item, money in minor units (pence). */
export interface CrmLineItem {
  description: string
  quantity: number
  unitPriceMinor: number
  vatRate?: number
}

/** Convert a CRM line item (minor units) to the API write shape (major units). */
export function lineItemToPayload(item: CrmLineItem): {
  description: string
  quantity: number
  unit_price: number
  vat_rate?: number
} {
  return {
    description: item.description,
    quantity: item.quantity,
    unit_price: toMajor(item.unitPriceMinor),
    ...(item.vatRate !== undefined ? { vat_rate: item.vatRate } : {}),
  }
}
