-- Seed the Direct Debit recovery template sequence (ADR 0045 amendment).
-- Four escalating email templates + four matching SMS/Trengo templates,
-- generalised (no personal names) + tokenised. The CCJ court fee, statutory
-- interest and totals are filled at send time; the legal_escalation email steps
-- also go out with a generated PDF copy of the letter. Idempotent: fixed ids +
-- ON CONFLICT DO NOTHING, so a re-run (or an operator having edited the copy in
-- Settings) is never overwritten. Also default new cases to a 7-day cadence to
-- match the protocol (7 days between steps).

ALTER TABLE "DirectDebitCase" ALTER COLUMN "cadenceDays" SET DEFAULT 7;

INSERT INTO "DdRecoveryTemplate"
  ("id", "name", "kind", "channel", "subject", "body", "sortOrder", "createdAt", "updatedAt")
VALUES
  ('ddtmpl_email_1_gentle', '1. Gentle reminder (email)', 'reminder'::"DdRecoveryTemplateKind", 'email'::"DdRecoveryChannel", 'Payment reminder — Medic Mind', 'Dear {{first_name}},

This is the Medic Mind Finance Team. We''re writing to remind you that your instalment of {{amount_due}} has not yet been received.

Please make sure there are sufficient funds in your account so the payment can be collected. You can also set your payment back up here:
{{setup_link}}

If you''re having any trouble, just reply to this message or call us on {{phone}}.

Thank you — we look forward to hearing from you.

Best wishes,
Medic Mind Finance', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ddtmpl_email_2_second', '2. Second reminder (email)', 'reminder'::"DdRecoveryTemplateKind", 'email'::"DdRecoveryChannel", 'Second reminder — outstanding payment to Medic Mind', 'Dear {{first_name}},

This is the Medic Mind Finance Team. We''re writing again about your instalment of {{amount_due}}, which we still have not received.

As we haven''t heard back for over a week, a late fee of {{late_fee}} may be added if payment isn''t made within the next 5 days, and any pending lessons may be paused.

You can set your payment back up straight away here:
{{setup_link}}

If you''re having trouble paying, please reply or call us on {{phone}} — we''d much rather help you find a way forward.

Best wishes,
Medic Mind Finance', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ddtmpl_email_3_stern', '3. Stern reminder before CCJ (email)', 'legal_escalation'::"DdRecoveryTemplateKind", 'email'::"DdRecoveryChannel", 'Important: overdue payment to Medic Mind', 'Dear {{first_name}},

This is the Medic Mind Finance Team writing about your overdue balance of {{amount_due}}, which remains unpaid.

A late fee of {{late_fee}} has now been applied, and as the agreed payment plan has not been kept to, it has been cancelled and the full balance is now due. Any pending lessons have been paused.

If this is not resolved, we may begin a claim through the County Court to recover the debt. If we do, we would also seek the court issue fee (currently about {{court_fee}}) and may claim statutory interest at 8% per year under section 69 of the County Courts Act 1984 ({{interest}} so far, increasing by {{daily_interest}} each day). A County Court Judgment can also affect your credit rating.

To avoid this, please pay or set your payment back up here before {{response_deadline}}:
{{setup_link}}

If you''re having difficulty, please reply or call us on {{phone}} — we''d still much rather resolve this with you directly.

Best wishes,
Medic Mind Finance', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ddtmpl_email_4_ccj', '4. Letter before claim / CCJ (email)', 'legal_escalation'::"DdRecoveryTemplateKind", 'email'::"DdRecoveryChannel", 'Letter before claim — outstanding balance of {{amount_due}}', 'Dear {{first_name}},

Re: Outstanding balance of {{amount_due}}

We are writing regarding your outstanding balance of {{amount_due}} for tutoring provided by Medic Mind, which remains unpaid despite our previous reminders.

This is our formal letter before claim. Unless the balance is paid, or you contact us to agree a way forward, by {{response_deadline}}, we intend to issue a claim against you in the County Court to recover the debt.

If a claim is issued, you may also become liable for:
- The court issue fee, currently about {{court_fee}}
- Statutory interest at 8% per year under section 69 of the County Courts Act 1984 — {{interest}} to date, increasing by {{daily_interest}} each day
- Our late fee of {{late_fee}}

This would bring the total to approximately {{total_with_costs}}. A County Court Judgment (CCJ) can also lead to enforcement action, and a CCJ remains on your credit record for six years, which can make it harder to obtain credit.

You entered into a contractual agreement to make these payments, and there is no clause allowing the contract to end without completing them. We do not intend to write off this debt.

To resolve this now, please pay or set your payment back up here:
{{setup_link}}

If you are having financial difficulty, please contact us on {{phone}} or reply to this email so we can discuss your options before any claim is issued.

Yours sincerely,
Medic Mind Finance Team
16 Tottenhall Rd, London N13 6HX
Tel: {{phone}} · info@medicmind.co.uk · www.medicmind.co.uk', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ddtmpl_sms_1_gentle', '1. Gentle reminder (text)', 'reminder'::"DdRecoveryTemplateKind", 'sms'::"DdRecoveryChannel", NULL, 'Hi {{first_name}}, Medic Mind here. We haven''t received your instalment of {{amount_due}}. Please top up your account or set your payment back up: {{setup_link}} — or call {{phone}} if you need help. Thanks.', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ddtmpl_sms_2_second', '2. Second reminder (text)', 'reminder'::"DdRecoveryTemplateKind", 'sms'::"DdRecoveryChannel", NULL, 'Hi {{first_name}}, your {{amount_due}} to Medic Mind is still outstanding. A late fee of {{late_fee}} may apply if it''s unpaid within 5 days and lessons may pause. Pay here: {{setup_link}} — or call {{phone}}.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ddtmpl_sms_3_stern', '3. Stern reminder before CCJ (text)', 'legal_escalation'::"DdRecoveryTemplateKind", 'sms'::"DdRecoveryChannel", NULL, 'Hi {{first_name}}, your Medic Mind balance of {{amount_due}} is overdue and a {{late_fee}} late fee has been applied. If unresolved we may start a County Court claim (adds about {{court_fee}} plus interest). Please pay by {{response_deadline}}: {{setup_link}}. Call {{phone}} to discuss.', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ddtmpl_sms_4_ccj', '4. Letter before claim / CCJ (text)', 'legal_escalation'::"DdRecoveryTemplateKind", 'sms'::"DdRecoveryChannel", NULL, 'Hi {{first_name}}, final notice from Medic Mind re {{amount_due}}. Unless paid or arranged by {{response_deadline}} we intend to issue a County Court claim (approx {{total_with_costs}} incl. fees and interest), which can affect your credit. Pay now: {{setup_link}} or call {{phone}}.', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
