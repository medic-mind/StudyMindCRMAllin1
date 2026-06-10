-- Repair Contact.phoneE164 rows stored without a country code (§16/§29 —
-- "a typed number always lands on the contact's phone field", but earlier
-- builds stored the digits as typed when no country resolved). Forward-only
-- data repair, conservative:
--   1. "00"-prefixed international numbers → "+<rest>".
--   2. UK-national shapes (leading 0, 10–11 digits) → "+44…", only when the
--      contact's country is unset or clearly the UK.
-- Anything else (foreign national digits with a known non-UK country) is
-- healed at runtime by the lead re-enquiry path, which now upgrades any
-- stored "+"-less number once the country is identified.

-- 1. 00-prefixed international: 0044…, 0051… → +44…, +51…
UPDATE "Contact" c
SET "phoneE164" = '+' || substring(c."phoneE164" from 3)
WHERE c."deletedAt" IS NULL
  AND c."phoneE164" ~ '^00[1-9][0-9]{8,13}$'
  AND NOT EXISTS (
    SELECT 1 FROM "Contact" other
    WHERE other."phoneE164" = '+' || substring(c."phoneE164" from 3)
      AND other.id <> c.id
  );

-- 2. UK national format: 0xxxxxxxxx(x) → +44xxxxxxxxx(x)
UPDATE "Contact" c
SET "phoneE164" = '+44' || substring(c."phoneE164" from 2)
WHERE c."deletedAt" IS NULL
  AND c."phoneE164" ~ '^0[1-9][0-9]{8,9}$'
  AND (
    c."country" IS NULL
    OR c."country" IN (
      'United Kingdom', 'UK', 'GB', 'Great Britain', 'England',
      'Scotland', 'Wales', 'Northern Ireland'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Contact" other
    WHERE other."phoneE164" = '+44' || substring(c."phoneE164" from 2)
      AND other.id <> c.id
  );

-- 3. UK mobile with the trunk 0 dropped: 7700900123 (10 digits) → +447700900123
UPDATE "Contact" c
SET "phoneE164" = '+44' || c."phoneE164"
WHERE c."deletedAt" IS NULL
  AND c."phoneE164" ~ '^7[0-9]{9}$'
  AND (
    c."country" IS NULL
    OR c."country" IN (
      'United Kingdom', 'UK', 'GB', 'Great Britain', 'England',
      'Scotland', 'Wales', 'Northern Ireland'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Contact" other
    WHERE other."phoneE164" = '+44' || c."phoneE164"
      AND other.id <> c.id
  );
