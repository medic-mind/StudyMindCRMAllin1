-- Per-group rich-HTML reminder body (authored in the chip editor). Nullable +
-- additive (forward-only, §19): existing groups fall back to text/default.
ALTER TABLE "WebinarClass" ADD COLUMN "emailBodyHtml" TEXT;
