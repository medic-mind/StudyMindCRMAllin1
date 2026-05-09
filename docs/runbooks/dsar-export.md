# Runbook: DSAR export

A Data Subject Access Request (DSAR) under UK GDPR requires us to give the
data subject a copy of every piece of personal data we hold about them.
StudyMind has a 30-day legal SLA from the date the request is received in
writing. This runbook is how we fulfil one without leaking data we should
not, and without missing data we must include.

CLAUDE.md §21. Endpoint: `GET /api/internal/dsar/{contactId}`.

## Who can request

A DSAR can come from:

- The data subject themselves (a parent, in our case usually).
- The parent or legal guardian of a minor whose data we hold.
- A solicitor or advocate acting on behalf of the data subject, with a
  signed letter of authority.

Requests for tutor or staff records are handled by HR, not this runbook.

Verify the requester's identity before fulfilling. For a parent, a recent
inbound email from the address we have on file plus a knowledge check
(date of last booking, billing reference) is sufficient. If anything feels
off, escalate to the DPO before exporting.

## Who can fulfil

Only an `admin` user can call the export endpoint. The endpoint enforces
this at the role check; agents and finance leads see a 403.

The DPO oversees DSARs and signs off on every fulfilment. The fulfilling
admin records the DPO sign-off in the request ticket.

## What is in the export

A single zip file named `dsar-{contactId}-{YYYY-MM-DD}.zip` containing one
JSON file per source table:

- `Contact.json` — the row.
- `FamilyMember.json` — every Family the contact belongs to.
- `Interaction.json` — every timeline event (own + family-scoped).
- `AuditLogEntry.json` — every audit row mentioning the contact.
- `Booking.json`, `BookingSession.json` — booking history.
- `Payment.json`, `RefundIntent.json` — finance per family.
- `ContactStatusSummary.json`, `ChurnScore.json` — AI artefacts.
- `EncryptedField.json` — DECRYPTED safeguarding fields. Each decryption
  writes a `safeguarding.field_decrypted` audit row before producing
  plaintext (CLAUDE.md §21.1). The export itself writes a `dsar.exported`
  audit row before reading anything.
- `manifest.json` — SHA-256 hash of every row, plus the actor, request id,
  and generation timestamp. Tamper-evident.

S3 referenced binaries (call recordings, email attachments) are linked by
their S3 key inside the relevant JSON; the operator may need to fetch them
separately if the requester asks for the underlying files. Most DSARs are
satisfied without the binaries.

## What is NOT in the export

- Other people's data. Where an Interaction includes a third party, only
  fields about the data subject are included; cross-referenced contact
  ids are redacted in a future pass (TODO #dsar-redact-third-parties).
- Provider raw payloads (`ProviderEvent`). These are operational
  artefacts, not personal data we curate.
- KMS key material, encrypted envelopes, or system credentials.

## Chain of custody

The export is generated on demand and never stored on our servers. The
admin downloads the zip to their device and delivers it to the requester
via a method agreed with the DPO (encrypted email, secure file share).
The local copy must be deleted within 7 days of delivery.

## Step-by-step

1. Open the DSAR ticket in the support tool. Verify identity.
2. Get DPO sign-off. Record in the ticket.
3. Look up the `contactId` in the CRM.
4. As an `admin`, call `GET /api/internal/dsar/{contactId}` from the
   browser. The browser saves `dsar-{contactId}-{date}.zip`.
5. Open `manifest.json` and confirm the entry count looks sensible.
6. Deliver per the agreed method.
7. Delete the local copy after delivery confirmation.
8. Close the ticket and log the fulfilment date.

If the export fails (5xx), open a Sev 2 incident — the legal SLA still
runs. The on-call engineer investigates via Sentry using the
`x-request-id` returned by the endpoint.
