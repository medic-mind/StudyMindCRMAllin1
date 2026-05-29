// Per-contact document attachments. CLAUDE.md §4 — DB-stored bytes so a
// self-hosted install needs no S3 (same trade-off as the branding logo).
//
// Pure validation + thin data helpers; the tRPC router owns RBAC and audit.

import type { Prisma, PrismaClient } from '@prisma/client'

type DbClient = PrismaClient | Prisma.TransactionClient

/** A reasonable upper bound for "small attachment". 8 MB. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

export class InvalidDocumentError extends Error {
  override readonly name = 'InvalidDocumentError'
}

export function assertValidDocument(input: {
  fileName: string
  contentType: string
  byteLength: number
}): void {
  if (!input.fileName.trim()) {
    throw new InvalidDocumentError('File name is required.')
  }
  if (input.fileName.length > 255) {
    throw new InvalidDocumentError('File name is too long.')
  }
  if (!(ALLOWED_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    throw new InvalidDocumentError(
      'File type not supported. Allowed: PDF, images, Office documents, plain text.',
    )
  }
  if (input.byteLength <= 0) {
    throw new InvalidDocumentError('File is empty.')
  }
  if (input.byteLength > MAX_DOCUMENT_BYTES) {
    throw new InvalidDocumentError('File must be 8 MB or smaller.')
  }
}

export interface AddDocumentInput {
  id: string
  contactId: string
  fileName: string
  contentType: string
  data: Buffer
  description?: string | null
  actorId: string | null
}

export async function addContactDocument(
  db: DbClient,
  input: AddDocumentInput,
): Promise<{ id: string; byteSize: number; createdAt: Date }> {
  assertValidDocument({
    fileName: input.fileName,
    contentType: input.contentType,
    byteLength: input.data.byteLength,
  })
  const row = await db.contactDocument.create({
    data: {
      id: input.id,
      contactId: input.contactId,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.data.byteLength,
      data: input.data,
      description: input.description ?? null,
      createdById: input.actorId,
    },
    select: { id: true, byteSize: true, createdAt: true },
  })
  return row
}

export async function listContactDocuments(db: DbClient, contactId: string) {
  return db.contactDocument.findMany({
    where: { contactId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fileName: true,
      contentType: true,
      byteSize: true,
      description: true,
      createdAt: true,
      createdById: true,
    },
  })
}

export async function getContactDocumentBytes(
  db: DbClient,
  id: string,
): Promise<{ contactId: string; fileName: string; contentType: string; data: Buffer } | null> {
  const row = await db.contactDocument.findUnique({
    where: { id },
    select: { contactId: true, fileName: true, contentType: true, data: true },
  })
  if (!row) return null
  return {
    contactId: row.contactId,
    fileName: row.fileName,
    contentType: row.contentType,
    data: Buffer.from(row.data),
  }
}

export async function removeContactDocument(db: DbClient, id: string): Promise<boolean> {
  const existing = await db.contactDocument.findUnique({
    where: { id },
    select: { id: true, contactId: true },
  })
  if (!existing) return false
  await db.contactDocument.delete({ where: { id } })
  return true
}
