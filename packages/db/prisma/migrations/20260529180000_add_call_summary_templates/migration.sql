-- Call summary templates — admin-managed prefill catalogue for the contact
-- page Call Summary panel (UCAT call, Medical Interview, Dental Interview,
-- etc). Optional attached PDF stored inline (same trade-off as
-- ContactDocument / BrandingSetting per CLAUDE.md §4).
--
-- Forward-only (CLAUDE.md §19). Seeds three defaults so the panel has
-- something useful out of the box; further templates are added from
-- /settings/call-summary-templates.

CREATE TABLE "CallSummaryTemplate" (
    "id"             TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "description"    TEXT,
    "body"           TEXT NOT NULL,
    "sortOrder"      INTEGER NOT NULL DEFAULT 0,
    "pdfFileName"    TEXT,
    "pdfContentType" TEXT,
    "pdfByteSize"    INTEGER,
    "pdfData"        BYTEA,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "createdById"    TEXT,
    "updatedById"    TEXT,
    "archivedAt"     TIMESTAMP(3),
    CONSTRAINT "CallSummaryTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallSummaryTemplate_name_key" ON "CallSummaryTemplate"("name");
CREATE INDEX "CallSummaryTemplate_archivedAt_idx" ON "CallSummaryTemplate"("archivedAt");
CREATE INDEX "CallSummaryTemplate_sortOrder_idx" ON "CallSummaryTemplate"("sortOrder");

-- Seed three operational defaults that match the user's examples. All fields
-- editable from Settings → Call summary templates; archive any that aren't
-- useful. PDFs can be attached after seeding.
INSERT INTO "CallSummaryTemplate" ("id", "name", "description", "body", "sortOrder", "updatedAt") VALUES
(
    'csmtmpl_ucat_call',
    'UCAT Call Summary',
    'Run-through of the UCAT prep conversation: target score, weak sections, study plan, next steps.',
    E'Discussed UCAT preparation with the parent / student.\n\nKey points covered:\n- Target score and university choices:\n- Sections to focus on (VR / DM / QR / AR / SJT):\n- Current performance / mock score:\n- Recommended package / hours:\n- Start date and tutor preference:\n\nAgreed next steps:\n- ',
    10,
    CURRENT_TIMESTAMP
),
(
    'csmtmpl_medical_interview',
    'Medical Interview Call Summary',
    'Run-through of the Medical Interview prep conversation: MMI vs panel, target med schools, prep plan.',
    E'Discussed Medical Interview preparation.\n\nKey points covered:\n- Universities applied to:\n- Interview formats expected (MMI / panel / hybrid):\n- Interview date(s):\n- Areas of concern (ethics / role-play / motivation / NHS hot topics):\n- Recommended mock + tuition package:\n- Tutor / consultant preference:\n\nAgreed next steps:\n- ',
    20,
    CURRENT_TIMESTAMP
),
(
    'csmtmpl_dental_interview',
    'Dental Interview Call Summary',
    'Run-through of the Dental Interview prep conversation: target dental schools, motivation, prep plan.',
    E'Discussed Dental Interview preparation.\n\nKey points covered:\n- Universities applied to:\n- Interview format (MMI / panel):\n- Interview date(s):\n- Areas of concern (manual dexterity / ethics / motivation / NHS topics):\n- Recommended mock + tuition package:\n- Tutor / consultant preference:\n\nAgreed next steps:\n- ',
    30,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;
