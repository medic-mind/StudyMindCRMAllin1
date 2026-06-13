-- GoCardless customer phone (ADR 0038, sixth amendment). A second contact-match
-- key after email, so a Direct Debit customer with no/non-matching email still
-- links to its CRM contact (and surfaces their DD data on the contact panel).
ALTER TABLE "GcCustomer" ADD COLUMN "phone" TEXT;
CREATE INDEX "GcCustomer_phone_idx" ON "GcCustomer"("phone");
