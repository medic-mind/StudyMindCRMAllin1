-- Branding: optional custom logo stored in Postgres so a self-hosted install
-- needs no AWS/S3 (CLAUDE.md §4). Singleton row keyed id = 'branding'. The
-- inline SVG brand mark remains the fallback when this table is empty.
CREATE TABLE "BrandingSetting" (
    "id" TEXT NOT NULL,
    "logoData" BYTEA NOT NULL,
    "logoContentType" TEXT NOT NULL,
    "logoFileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    CONSTRAINT "BrandingSetting_pkey" PRIMARY KEY ("id")
);
