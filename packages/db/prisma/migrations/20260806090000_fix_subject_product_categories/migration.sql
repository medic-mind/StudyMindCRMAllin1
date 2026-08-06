-- Study Mind subject products were seeded with the LEVEL as their category:
-- maths/biology/chemistry/physics-tuition all carried category 'A-Level'.
--
-- classifyLead pushes a matched product's category into the lead's categories,
-- so the subject never reached them: an enquiry from
-- /subject/a-level-chemistry-tutors/ matched `chemistry-tuition` yet produced
-- categories ['A-Level'] and a Subject tag of "A-Level". The subject was
-- detected and then thrown away.
--
-- Point each subject product at its actual subject. The level is still stamped
-- on the lead by the `a-level` / `gcse` / `ib-tuition` URL rules, so nothing is
-- lost — the Subject slot now gets the topic and the level stays a category.
--
-- Guarded on the seeded ids and on the wrong value, so a category an operator
-- has already corrected by hand is never overwritten (CLAUDE.md §3).

UPDATE "ProductCatalogueItem" SET "category" = 'Maths',     "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'prd_seed_maths'     AND "category" = 'A-Level';
UPDATE "ProductCatalogueItem" SET "category" = 'Biology',   "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'prd_seed_biology'   AND "category" = 'A-Level';
UPDATE "ProductCatalogueItem" SET "category" = 'Chemistry', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'prd_seed_chemistry' AND "category" = 'A-Level';
UPDATE "ProductCatalogueItem" SET "category" = 'Physics',   "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = 'prd_seed_physics'   AND "category" = 'A-Level';
