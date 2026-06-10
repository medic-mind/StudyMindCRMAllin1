-- Lead provenance: client IP + derived country (ADR 0023 follow-up). The IP
-- is captured at /api/leads ingest; the classify job resolves a country from
-- the form's country field or an IP geo lookup, and uses it to compose a full
-- international phone number from locally-typed digits.
ALTER TABLE "Lead" ADD COLUMN "ip"          TEXT;
ALTER TABLE "Lead" ADD COLUMN "countryCode" TEXT;
