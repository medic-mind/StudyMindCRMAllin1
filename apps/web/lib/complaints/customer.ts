// Pure helper: resolve a complaint's customer identity for display. A complaint
// is logged against a CRM contact OR a manually-typed person (name + phone) —
// this collapses either into one shape the UI + Slack sender render. Kept pure
// (no I/O) so it is unit-tested in isolation.

export interface ComplaintCustomerSource {
  contact: {
    id: string
    firstName: string | null
    lastName: string | null
    email: string | null
    phoneE164: string | null
  } | null
  personName: string | null
  personPhone: string | null
  personEmail: string | null
}

export interface ComplaintCustomer {
  /** The linked CRM contact id, or null for a manual complaint. */
  contactId: string | null
  name: string
  phone: string | null
  email: string | null
  /** True when there is no CRM contact — a manually-typed person. */
  manual: boolean
}

export function complaintCustomer(c: ComplaintCustomerSource): ComplaintCustomer {
  if (c.contact) {
    const name =
      [c.contact.firstName, c.contact.lastName].filter(Boolean).join(' ').trim() ||
      c.contact.email ||
      'Customer'
    return {
      contactId: c.contact.id,
      name,
      phone: c.contact.phoneE164,
      email: c.contact.email,
      manual: false,
    }
  }
  return {
    contactId: null,
    name:
      c.personName?.trim() || c.personPhone?.trim() || c.personEmail?.trim() || 'Manual customer',
    phone: c.personPhone ?? null,
    email: c.personEmail ?? null,
    manual: true,
  }
}
