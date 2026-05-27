// Branding domain (CLAUDE.md §4). A single optional custom logo, stored in
// Postgres so a self-hosted install works without AWS/S3. Pure validation +
// thin data helpers; the tRPC router owns RBAC and audit.
//
// SVG is intentionally NOT accepted: SVGs can carry script and we serve the
// bytes from an endpoint. Raster formats only; the inline SVG brand mark
// stays as the vector fallback when no custom logo is set.

import type { Prisma, PrismaClient } from '@prisma/client'

export const BRANDING_SINGLETON_ID = 'branding'

export const ALLOWED_LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type LogoContentType = (typeof ALLOWED_LOGO_CONTENT_TYPES)[number]

/** 512 KB — generous for a logo, small enough to keep in a single row. */
export const MAX_LOGO_BYTES = 512 * 1024

type DbClient = PrismaClient | Prisma.TransactionClient

export class InvalidLogoError extends Error {
  override readonly name = 'InvalidLogoError'
}

export function assertValidLogo(input: { contentType: string; byteLength: number }): void {
  if (!(ALLOWED_LOGO_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw new InvalidLogoError('Logo must be a PNG, JPEG, or WebP image.')
  }
  if (input.byteLength <= 0) {
    throw new InvalidLogoError('Logo file is empty.')
  }
  if (input.byteLength > MAX_LOGO_BYTES) {
    throw new InvalidLogoError('Logo must be 512 KB or smaller.')
  }
}

export interface BrandingLogoMeta {
  hasLogo: boolean
  contentType: string | null
  /** Epoch millis of the last update — used to cache-bust the logo URL. */
  version: number | null
}

export async function getBrandingLogoMeta(db: DbClient): Promise<BrandingLogoMeta> {
  const row = await db.brandingSetting.findUnique({
    where: { id: BRANDING_SINGLETON_ID },
    select: { logoContentType: true, updatedAt: true },
  })
  return {
    hasLogo: row !== null,
    contentType: row?.logoContentType ?? null,
    version: row ? row.updatedAt.getTime() : null,
  }
}

export async function getBrandingLogoBytes(
  db: DbClient,
): Promise<{ data: Buffer; contentType: string } | null> {
  const row = await db.brandingSetting.findUnique({
    where: { id: BRANDING_SINGLETON_ID },
    select: { logoData: true, logoContentType: true },
  })
  if (!row) return null
  return { data: Buffer.from(row.logoData), contentType: row.logoContentType }
}

export interface SetBrandingLogoInput {
  data: Buffer
  contentType: string
  fileName?: string | null
  actorId: string | null
}

export async function setBrandingLogo(
  db: DbClient,
  input: SetBrandingLogoInput,
): Promise<{ version: number }> {
  assertValidLogo({ contentType: input.contentType, byteLength: input.data.byteLength })
  const row = await db.brandingSetting.upsert({
    where: { id: BRANDING_SINGLETON_ID },
    create: {
      id: BRANDING_SINGLETON_ID,
      logoData: input.data,
      logoContentType: input.contentType,
      logoFileName: input.fileName ?? null,
      createdById: input.actorId,
      updatedById: input.actorId,
    },
    update: {
      logoData: input.data,
      logoContentType: input.contentType,
      logoFileName: input.fileName ?? null,
      updatedById: input.actorId,
    },
  })
  return { version: row.updatedAt.getTime() }
}

export async function clearBrandingLogo(db: DbClient): Promise<boolean> {
  const existing = await db.brandingSetting.findUnique({
    where: { id: BRANDING_SINGLETON_ID },
    select: { id: true },
  })
  if (!existing) return false
  await db.brandingSetting.delete({ where: { id: BRANDING_SINGLETON_ID } })
  return true
}
