-- Zoom connect-from-Settings + automatic link rotation (ADR 0035 amendment).
-- Server-to-Server OAuth credentials pasted in the UI (secret envelope-
-- encrypted, §21 — mirrors InvoicingSetting); ZOOM_* env vars stay as the
-- fallback. Classes rotate their Zoom link automatically when due unless the
-- per-class toggle is switched off. Forward-only.

ALTER TABLE "WebinarSettings"
  ADD COLUMN "zoomAccountId" TEXT,
  ADD COLUMN "zoomClientId" TEXT,
  ADD COLUMN "zoomClientSecretCiphertext" BYTEA,
  ADD COLUMN "zoomClientSecretIv" BYTEA,
  ADD COLUMN "zoomClientSecretDekCiphertext" BYTEA,
  ADD COLUMN "zoomClientSecretAad" BYTEA,
  ADD COLUMN "zoomClientSecretKeyVersion" INTEGER;

ALTER TABLE "WebinarClass"
  ADD COLUMN "zoomAutoRotate" BOOLEAN NOT NULL DEFAULT true;
