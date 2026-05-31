-- Dynamic lead ingestion + classification engine (ADR 0023).
--
-- Extends Lead with landing-page intelligence + classification output, and
-- adds the configurable rule tables that let ops route any Contact-Form-7
-- site without a developer:
--   • LeadSource             — per-website API key for POST /api/leads
--   • BrandDomainRule        — domain → Company (brand detection)
--   • UrlClassificationRule  — slug/URL/title → product tags + categories
--   • ProductCatalogueItem   — master product catalogue
--   • LeadClassificationCorrection — staff corrections (learning substrate)
--
-- All Lead columns are additive + nullable (or defaulted) so the legacy
-- /api/webhooks/lead path keeps working unchanged. CLAUDE.md §16, §19.

-- 0. New Interaction type for web enquiries (enum append, §19). Not used in
--    this migration, so safe to add ahead of the columns/tables below.
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'lead_enquiry';

-- 1. Extend Lead -------------------------------------------------------------
ALTER TABLE "Lead" ADD COLUMN "sourceId"        TEXT;
ALTER TABLE "Lead" ADD COLUMN "brandCompanyId"  TEXT;
ALTER TABLE "Lead" ADD COLUMN "landingDomain"   TEXT;
ALTER TABLE "Lead" ADD COLUMN "landingUrl"      TEXT;
ALTER TABLE "Lead" ADD COLUMN "landingSlug"     TEXT;
ALTER TABLE "Lead" ADD COLUMN "formTitle"       TEXT;
ALTER TABLE "Lead" ADD COLUMN "formId"          TEXT;
ALTER TABLE "Lead" ADD COLUMN "referrer"        TEXT;
ALTER TABLE "Lead" ADD COLUMN "utm"             JSONB;
ALTER TABLE "Lead" ADD COLUMN "categories"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Lead" ADD COLUMN "productTags"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Lead" ADD COLUMN "score"           INTEGER;
ALTER TABLE "Lead" ADD COLUMN "classification"  JSONB;
ALTER TABLE "Lead" ADD COLUMN "classifiedAt"    TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "status"          TEXT NOT NULL DEFAULT 'received';
ALTER TABLE "Lead" ADD COLUMN "cardId"          TEXT;

CREATE INDEX "Lead_status_idx"          ON "Lead"("status");
CREATE INDEX "Lead_sourceId_idx"        ON "Lead"("sourceId");
CREATE INDEX "Lead_brandCompanyId_idx"  ON "Lead"("brandCompanyId");
CREATE INDEX "Lead_createdAt_idx"       ON "Lead"("createdAt");

-- 2. LeadSource --------------------------------------------------------------
CREATE TABLE "LeadSource" (
    "id"             TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "slug"           TEXT NOT NULL,
    "keyHash"        TEXT NOT NULL,
    "keyLast4"       TEXT NOT NULL,
    "defaultBrandId" TEXT,
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "leadCount"      INTEGER NOT NULL DEFAULT 0,
    "lastLeadAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "createdById"    TEXT,
    "updatedById"    TEXT,
    "archivedAt"     TIMESTAMP(3),
    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadSource_slug_key"        ON "LeadSource"("slug");
CREATE UNIQUE INDEX "LeadSource_keyHash_key"     ON "LeadSource"("keyHash");
CREATE INDEX "LeadSource_active_idx"             ON "LeadSource"("active");
CREATE INDEX "LeadSource_defaultBrandId_idx"     ON "LeadSource"("defaultBrandId");

-- 3. BrandDomainRule ---------------------------------------------------------
CREATE TABLE "BrandDomainRule" (
    "id"          TEXT NOT NULL,
    "pattern"     TEXT NOT NULL,
    "companyId"   TEXT NOT NULL,
    "priority"    INTEGER NOT NULL DEFAULT 100,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    CONSTRAINT "BrandDomainRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BrandDomainRule_active_idx"    ON "BrandDomainRule"("active");
CREATE INDEX "BrandDomainRule_companyId_idx" ON "BrandDomainRule"("companyId");

-- 4. UrlClassificationRule ---------------------------------------------------
CREATE TABLE "UrlClassificationRule" (
    "id"          TEXT NOT NULL,
    "label"       TEXT NOT NULL,
    "pattern"     TEXT NOT NULL,
    "matchType"   TEXT NOT NULL DEFAULT 'contains',
    "productTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "categories"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "brandId"     TEXT,
    "priority"    INTEGER NOT NULL DEFAULT 100,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    CONSTRAINT "UrlClassificationRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UrlClassificationRule_active_idx"  ON "UrlClassificationRule"("active");
CREATE INDEX "UrlClassificationRule_brandId_idx" ON "UrlClassificationRule"("brandId");

-- 5. ProductCatalogueItem ----------------------------------------------------
CREATE TABLE "ProductCatalogueItem" (
    "id"          TEXT NOT NULL,
    "brandId"     TEXT,
    "handle"      TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "category"    TEXT NOT NULL,
    "aliases"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    CONSTRAINT "ProductCatalogueItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductCatalogueItem_handle_key"  ON "ProductCatalogueItem"("handle");
CREATE INDEX "ProductCatalogueItem_active_idx"         ON "ProductCatalogueItem"("active");
CREATE INDEX "ProductCatalogueItem_brandId_idx"        ON "ProductCatalogueItem"("brandId");
CREATE INDEX "ProductCatalogueItem_category_idx"       ON "ProductCatalogueItem"("category");

-- 6. LeadClassificationCorrection -------------------------------------------
CREATE TABLE "LeadClassificationCorrection" (
    "id"        TEXT NOT NULL,
    "leadId"    TEXT NOT NULL,
    "field"     TEXT NOT NULL,
    "fromValue" JSONB,
    "toValue"   JSONB NOT NULL,
    "actorId"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadClassificationCorrection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LeadClassificationCorrection_leadId_idx" ON "LeadClassificationCorrection"("leadId");
CREATE INDEX "LeadClassificationCorrection_field_idx"  ON "LeadClassificationCorrection"("field");

-- 7. Foreign keys ------------------------------------------------------------
ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "LeadSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead"
    ADD CONSTRAINT "Lead_brandCompanyId_fkey"
    FOREIGN KEY ("brandCompanyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeadSource"
    ADD CONSTRAINT "LeadSource_defaultBrandId_fkey"
    FOREIGN KEY ("defaultBrandId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BrandDomainRule"
    ADD CONSTRAINT "BrandDomainRule_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UrlClassificationRule"
    ADD CONSTRAINT "UrlClassificationRule_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductCatalogueItem"
    ADD CONSTRAINT "ProductCatalogueItem_brandId_fkey"
    FOREIGN KEY ("brandId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeadClassificationCorrection"
    ADD CONSTRAINT "LeadClassificationCorrection_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 8. Seed the two missing sister brands (Medic / Oxbridge / Study already
--    exist from 20260527170000). Ops can rename / recolour / archive these
--    from Settings → Companies. CLAUDE.md §4.
INSERT INTO "Company" ("id", "name", "slug", "color", "updatedAt") VALUES
    ('cmp_seed_law_mind', 'Law Mind', 'law-mind', '#0f766e', CURRENT_TIMESTAMP),
    ('cmp_seed_vet_mind', 'Vet Mind', 'vet-mind', '#16a34a', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 9. Seed domain → brand rules. Editable from the CRM afterwards.
INSERT INTO "BrandDomainRule" ("id", "pattern", "companyId", "priority", "updatedAt") VALUES
    ('bdr_seed_medicmind',    'medicmind.co.uk',    'cmp_seed_medic_mind',    100, CURRENT_TIMESTAMP),
    ('bdr_seed_studymind',    'studymind.co.uk',    'cmp_seed_study_mind',    100, CURRENT_TIMESTAMP),
    ('bdr_seed_oxbridgemind', 'oxbridgemind.co.uk', 'cmp_seed_oxbridge_mind', 100, CURRENT_TIMESTAMP),
    ('bdr_seed_lawmind',      'lawmind.co.uk',      'cmp_seed_law_mind',      100, CURRENT_TIMESTAMP),
    ('bdr_seed_vetmind',      'vetmind.co.uk',      'cmp_seed_vet_mind',      100, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 10. Seed URL / slug intelligence rules. Exam-specific rules run first
--     (lower priority number); generic service rules accumulate after.
INSERT INTO "UrlClassificationRule"
    ("id", "label", "pattern", "matchType", "productTags", "categories", "brandId", "priority", "updatedAt")
VALUES
    ('urc_seed_ucat',     'UCAT',                 'ucat',              'contains', ARRAY['ucat'],               ARRAY['UCAT'],                 'cmp_seed_medic_mind',    50, CURRENT_TIMESTAMP),
    ('urc_seed_gamsat',   'GAMSAT',               'gamsat',            'contains', ARRAY['gamsat'],             ARRAY['GAMSAT'],               'cmp_seed_medic_mind',    50, CURRENT_TIMESTAMP),
    ('urc_seed_imat',     'IMAT',                 'imat',              'contains', ARRAY['imat'],               ARRAY['IMAT','International Medicine'], 'cmp_seed_medic_mind', 50, CURRENT_TIMESTAMP),
    ('urc_seed_bmat',     'BMAT',                 'bmat',              'contains', ARRAY['bmat'],               ARRAY['BMAT'],                 'cmp_seed_medic_mind',    50, CURRENT_TIMESTAMP),
    ('urc_seed_tmua',     'TMUA',                 'tmua',              'contains', ARRAY['tmua'],               ARRAY['TMUA'],                 'cmp_seed_oxbridge_mind', 50, CURRENT_TIMESTAMP),
    ('urc_seed_esat',     'ESAT',                 'esat',              'contains', ARRAY['esat'],               ARRAY['ESAT'],                 'cmp_seed_oxbridge_mind', 50, CURRENT_TIMESTAMP),
    ('urc_seed_tara',     'TARA',                 'tara',              'contains', ARRAY['tara'],               ARRAY['TARA'],                 'cmp_seed_oxbridge_mind', 50, CURRENT_TIMESTAMP),
    ('urc_seed_lnat',     'LNAT',                 'lnat',              'contains', ARRAY['lnat'],               ARRAY['LNAT','Law Admissions'], 'cmp_seed_law_mind',     50, CURRENT_TIMESTAMP),
    ('urc_seed_pat',      'PAT',                  'pat',               'contains', ARRAY['pat'],                ARRAY['PAT','Physics Admissions'], 'cmp_seed_oxbridge_mind', 50, CURRENT_TIMESTAMP),
    ('urc_seed_mat',      'MAT',                  'mat',               'contains', ARRAY['mat'],                ARRAY['MAT','Mathematics Admissions'], 'cmp_seed_oxbridge_mind', 60, CURRENT_TIMESTAMP),
    ('urc_seed_tsa',      'TSA',                  'tsa',               'contains', ARRAY['tsa'],                ARRAY['TSA'],                  'cmp_seed_oxbridge_mind', 50, CURRENT_TIMESTAMP),
    ('urc_seed_step',     'STEP',                 'step',              'contains', ARRAY['step'],               ARRAY['STEP','Mathematics Admissions'], 'cmp_seed_oxbridge_mind', 50, CURRENT_TIMESTAMP),
    ('urc_seed_medicine', 'Medicine',             'medicine',          'contains', ARRAY[]::TEXT[],             ARRAY['Medicine Applications'], 'cmp_seed_medic_mind',   100, CURRENT_TIMESTAMP),
    ('urc_seed_dentistry','Dentistry',            'dentistry',         'contains', ARRAY[]::TEXT[],             ARRAY['Dentistry Applications'], 'cmp_seed_medic_mind',  100, CURRENT_TIMESTAMP),
    ('urc_seed_vet',      'Veterinary',           'veterinary',        'contains', ARRAY[]::TEXT[],             ARRAY['Veterinary'],           'cmp_seed_vet_mind',     100, CURRENT_TIMESTAMP),
    ('urc_seed_law',      'Law',                  'law',               'contains', ARRAY[]::TEXT[],             ARRAY['Law Admissions'],       'cmp_seed_law_mind',     100, CURRENT_TIMESTAMP),
    ('urc_seed_oxbridge', 'Oxbridge',             'oxbridge',          'contains', ARRAY[]::TEXT[],             ARRAY['Oxbridge Admissions'],  'cmp_seed_oxbridge_mind', 90, CURRENT_TIMESTAMP),
    ('urc_seed_oxford',   'Oxford',               'oxford',            'contains', ARRAY[]::TEXT[],             ARRAY['Oxford Admissions'],    'cmp_seed_oxbridge_mind', 90, CURRENT_TIMESTAMP),
    ('urc_seed_cambridge','Cambridge',            'cambridge',         'contains', ARRAY[]::TEXT[],             ARRAY['Cambridge Admissions'], 'cmp_seed_oxbridge_mind', 90, CURRENT_TIMESTAMP),
    ('urc_seed_interview','Interview',            'interview',         'contains', ARRAY['mmi-interview'],      ARRAY['Interview'],            NULL,                    100, CURRENT_TIMESTAMP),
    ('urc_seed_mmi',      'MMI Interview',        'mmi',               'contains', ARRAY['mmi-interview'],      ARRAY['Interview'],            'cmp_seed_medic_mind',   100, CURRENT_TIMESTAMP),
    ('urc_seed_ps',       'Personal Statement',   'personal-statement','contains', ARRAY['personal-statement'], ARRAY['Personal Statement'],  NULL,                    100, CURRENT_TIMESTAMP),
    ('urc_seed_tutoring', 'Tutoring',             'tutoring',          'contains', ARRAY[]::TEXT[],             ARRAY['Tutoring'],             NULL,                    100, CURRENT_TIMESTAMP),
    ('urc_seed_tuition',  'Tuition',              'tuition',           'contains', ARRAY[]::TEXT[],             ARRAY['Tutoring'],             'cmp_seed_study_mind',   100, CURRENT_TIMESTAMP),
    ('urc_seed_course',   'Course',               'course',           'contains', ARRAY[]::TEXT[],             ARRAY['Course'],               NULL,                    110, CURRENT_TIMESTAMP),
    ('urc_seed_mentoring','Mentoring',            'mentoring',         'contains', ARRAY[]::TEXT[],             ARRAY['Mentoring'],            NULL,                    100, CURRENT_TIMESTAMP),
    ('urc_seed_workexp',  'Work Experience',      'work-experience',   'contains', ARRAY[]::TEXT[],             ARRAY['Work Experience'],      'cmp_seed_medic_mind',   100, CURRENT_TIMESTAMP),
    ('urc_seed_consult',  'Consultation',         'consultation',      'contains', ARRAY[]::TEXT[],             ARRAY['Consultation'],         NULL,                    100, CURRENT_TIMESTAMP),
    ('urc_seed_gcse',     'GCSE',                 'gcse',              'contains', ARRAY[]::TEXT[],             ARRAY['GCSE'],                 'cmp_seed_study_mind',   100, CURRENT_TIMESTAMP),
    ('urc_seed_alevel',   'A-Level',              'a-level',           'contains', ARRAY[]::TEXT[],             ARRAY['A-Level'],              'cmp_seed_study_mind',   100, CURRENT_TIMESTAMP),
    ('urc_seed_ib',       'IB',                   'ib-tuition',        'contains', ARRAY[]::TEXT[],             ARRAY['IB'],                   'cmp_seed_study_mind',   100, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- 11. Seed a representative master product catalogue. Ops extends the rest
--     from Settings without code (spec: master product catalogue).
INSERT INTO "ProductCatalogueItem" ("id", "brandId", "handle", "name", "category", "aliases", "updatedAt") VALUES
    ('prd_seed_ucat_course',     'cmp_seed_medic_mind',    'ucat-course',          'UCAT Course',              'UCAT',                  ARRAY['ucat'], CURRENT_TIMESTAMP),
    ('prd_seed_ucat_tutoring',   'cmp_seed_medic_mind',    'ucat-tutoring',        'UCAT Tutoring',            'UCAT',                  ARRAY['ucat tutor'], CURRENT_TIMESTAMP),
    ('prd_seed_ucat_crash',      'cmp_seed_medic_mind',    'ucat-crash-course',    'UCAT Crash Course',        'UCAT',                  ARRAY['ucat crash'], CURRENT_TIMESTAMP),
    ('prd_seed_ucat_mocks',      'cmp_seed_medic_mind',    'ucat-mock-exams',      'UCAT Mock Exams',          'UCAT',                  ARRAY['ucat mocks'], CURRENT_TIMESTAMP),
    ('prd_seed_gamsat',          'cmp_seed_medic_mind',    'gamsat',               'GAMSAT Preparation',       'GAMSAT',                ARRAY['gamsat'], CURRENT_TIMESTAMP),
    ('prd_seed_imat',            'cmp_seed_medic_mind',    'imat',                 'IMAT Preparation',         'IMAT',                  ARRAY['imat'], CURRENT_TIMESTAMP),
    ('prd_seed_med_apps',        'cmp_seed_medic_mind',    'medicine-applications','Medicine Applications',    'Medicine Applications', ARRAY['medicine application'], CURRENT_TIMESTAMP),
    ('prd_seed_med_ps',          'cmp_seed_medic_mind',    'medicine-personal-statement','Medicine Personal Statement','Personal Statement', ARRAY['medicine ps'], CURRENT_TIMESTAMP),
    ('prd_seed_mmi',             'cmp_seed_medic_mind',    'mmi-interview',        'MMI Interview',            'Interview',             ARRAY['mmi'], CURRENT_TIMESTAMP),
    ('prd_seed_panel',           'cmp_seed_medic_mind',    'panel-interview',      'Panel Interview',          'Interview',             ARRAY['panel'], CURRENT_TIMESTAMP),
    ('prd_seed_med_workexp',     'cmp_seed_medic_mind',    'medicine-work-experience','Medicine Work Experience','Work Experience',     ARRAY['work experience'], CURRENT_TIMESTAMP),
    ('prd_seed_dent_apps',       'cmp_seed_medic_mind',    'dentistry-applications','Dentistry Applications',  'Dentistry Applications',ARRAY['dentistry'], CURRENT_TIMESTAMP),
    ('prd_seed_dent_interview',  'cmp_seed_medic_mind',    'dentistry-interview',  'Dentistry Interview',      'Interview',             ARRAY['dentistry interview'], CURRENT_TIMESTAMP),
    ('prd_seed_esat',            'cmp_seed_oxbridge_mind', 'esat',                 'ESAT Preparation',         'ESAT',                  ARRAY['esat'], CURRENT_TIMESTAMP),
    ('prd_seed_tmua',            'cmp_seed_oxbridge_mind', 'tmua',                 'TMUA Preparation',         'TMUA',                  ARRAY['tmua'], CURRENT_TIMESTAMP),
    ('prd_seed_pat',             'cmp_seed_oxbridge_mind', 'pat',                  'PAT Preparation',          'PAT',                   ARRAY['pat'], CURRENT_TIMESTAMP),
    ('prd_seed_mat',             'cmp_seed_oxbridge_mind', 'mat',                  'MAT Preparation',          'MAT',                   ARRAY['mat'], CURRENT_TIMESTAMP),
    ('prd_seed_tsa',             'cmp_seed_oxbridge_mind', 'tsa',                  'TSA Preparation',          'TSA',                   ARRAY['tsa'], CURRENT_TIMESTAMP),
    ('prd_seed_step',            'cmp_seed_oxbridge_mind', 'step',                 'STEP Preparation',         'STEP',                  ARRAY['step'], CURRENT_TIMESTAMP),
    ('prd_seed_oxb_admissions',  'cmp_seed_oxbridge_mind', 'oxbridge-admissions',  'Oxbridge Admissions',      'Oxbridge Admissions',   ARRAY['oxbridge'], CURRENT_TIMESTAMP),
    ('prd_seed_oxb_interview',   'cmp_seed_oxbridge_mind', 'oxbridge-interview',   'Oxbridge Interview',       'Interview',             ARRAY['oxbridge interview'], CURRENT_TIMESTAMP),
    ('prd_seed_lnat',            'cmp_seed_law_mind',      'lnat',                 'LNAT Preparation',         'LNAT',                  ARRAY['lnat'], CURRENT_TIMESTAMP),
    ('prd_seed_law_admissions',  'cmp_seed_law_mind',      'law-admissions',       'Law Admissions',           'Law Admissions',        ARRAY['law'], CURRENT_TIMESTAMP),
    ('prd_seed_gcse_tuition',    'cmp_seed_study_mind',    'gcse-tuition',         'GCSE Tuition',             'GCSE',                  ARRAY['gcse'], CURRENT_TIMESTAMP),
    ('prd_seed_alevel_tuition',  'cmp_seed_study_mind',    'a-level-tuition',      'A-Level Tuition',          'A-Level',               ARRAY['a level','alevel'], CURRENT_TIMESTAMP),
    ('prd_seed_ib_tuition',      'cmp_seed_study_mind',    'ib-tuition',           'IB Tuition',               'IB',                    ARRAY['ib'], CURRENT_TIMESTAMP),
    ('prd_seed_maths',           'cmp_seed_study_mind',    'maths-tuition',        'Mathematics Tuition',      'A-Level',               ARRAY['maths','mathematics'], CURRENT_TIMESTAMP),
    ('prd_seed_biology',         'cmp_seed_study_mind',    'biology-tuition',      'Biology Tuition',          'A-Level',               ARRAY['biology'], CURRENT_TIMESTAMP),
    ('prd_seed_chemistry',       'cmp_seed_study_mind',    'chemistry-tuition',    'Chemistry Tuition',        'A-Level',               ARRAY['chemistry'], CURRENT_TIMESTAMP),
    ('prd_seed_physics',         'cmp_seed_study_mind',    'physics-tuition',      'Physics Tuition',          'A-Level',               ARRAY['physics'], CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
