# Runbook: Safeguarding LA referral

Recording a referral to a Local Authority children's services department or to the Multi-Agency Safeguarding Hub (MASH). The CRM does not send the referral — that goes via the LA's own intake channel — but it is the system of record that the referral happened. See CLAUDE.md §42.4.

## Who can record

- **DSL** can record directly.
- **Deputy DSL** can record if the DSL is unreachable, but the DSL must sign off after the fact within 24 hours. The Interaction stays in `pending_dsl_signoff` until they do.
- **Ops agents** cannot record referrals. If an agent has information that should trigger a referral, they raise a safeguarding concern (CLAUDE.md §42.1) at `urgent` or `immediate` urgency, and the DSL takes it from there.

## The Interaction

`safeguarding.la_referral` is the registered event name (CLAUDE.md §45). It writes:

- An `Interaction` row on both the Contact (the child) and the Family.
- An `AuditLogEntry` with `actor_id`, `target`, `request_id`, `purpose: 'la_referral_recorded'`.
- A row in the safeguarding referral tracker, used for SLA chasing.

## Fields captured

All fields are validated by the Zod schema in `packages/core/safeguarding/types.ts`:

- **LA name.** From the controlled list of LAs we work with; free text only with DSL approval.
- **Caseworker.** Name and contact (email or phone). Optional at recording time, required before the referral closes.
- **Reference number.** The LA's case reference. Optional initially; once issued by the LA, mandatory.
- **Date and time of referral.** UTC stored, displayed in Europe/London.
- **Channel.** `phone | email | secure_portal | written | in_person`.
- **Concern body.** Free text. **Encrypted** at rest using envelope encryption (CLAUDE.md §21.1). The plaintext is never written to logs or AI prompts.
- **Response expected by.** A date the LA committed to (or our default SLA — see escalation below).
- **Linked safeguarding flag.** The `SafeguardingFlag` row that prompted the referral.

## Encryption and access

The concern body is an `EncryptedField` row. Decryption requires the `dsl` role and a non-empty `purpose` string (CLAUDE.md §41.3, §21.1). Every read writes an `AuditLogEntry`.

The `Contact`'s `safeguarding_flag` is moved to `restricted_access` if it was not already (CLAUDE.md §42.3). This hides notes from non-DSL users immediately.

## Retention

Referral records follow the parent LA contract's retention override. Default for safeguarding material is **25 years from the child's date of birth** (CLAUDE.md §21). The `RetentionPolicy` row attached to the LA contract or to the Contact carries the override; the `compliance/enforce-retention` job respects it.

## Audit prompt on read

Every subsequent read of the referral body fires the standard DSL audit prompt: "why are you reading this?" The reason string lands in `AuditLogEntry.purpose` and is queryable in the safeguarding audit dashboard.

## Escalation if no LA response

We track responses against the `response_expected_by` date.

- **5 working days before deadline.** Reminder appears on the DSL dashboard.
- **On deadline.** Tracker turns amber. DSL triages: chase by phone, recorded as a `safeguarding.la_referral_chased` Interaction.
- **3 working days past deadline.** Tracker turns red. DSL escalates to LA team manager. If the case is `immediate` urgency and there is still no response, escalate to the named DPO and consider a parallel referral to police where the threshold is met. None of this is automatic — the system surfaces, the DSL decides.

## What ops can see

Ops agents see a banner on the Family and Contact: "This contact has an open safeguarding referral. Contact the DSL before sending any communication." They cannot:

- Read the concern body.
- See the LA reference, caseworker, or response date.
- Reply to the family from Trengo (outbound is locked to DSL inbox — CLAUDE.md §42.3).

They can see that the referral exists and who the assigned DSL is.

## Closing a referral

A referral is closed by the DSL with one of: `outcome_no_action`, `outcome_section_17`, `outcome_section_47`, `outcome_other` plus a free-text rationale. Closing writes a `safeguarding.la_referral_closed` Interaction. The retention clock for the encrypted body starts from the close date if no other policy applies; otherwise the longer policy wins.
