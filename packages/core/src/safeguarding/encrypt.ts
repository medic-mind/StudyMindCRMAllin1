// Field-level envelope encryption. CLAUDE.md §21.1.
//
// 1. KMS GenerateDataKey produces a fresh AES-256 DEK (plaintext + ciphertext).
// 2. AES-256-GCM encrypts the plaintext with the DEK; IV is 12 random bytes.
// 3. AAD = `${ownerType}|${ownerId}|${fieldName}|${keyVersion}`.
// 4. Persist ciphertext + iv + dekCiphertext + aad + keyVersion in
//    EncryptedField.
// 5. Audit row written. AAD binds the row to its owner so a swap fails
//    closed in decrypt.

import { createCipheriv, randomBytes } from 'node:crypto'

import { GenerateDataKeyCommand } from '@aws-sdk/client-kms'
import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { getKmsClient, getKmsKeyId, KEY_VERSION } from './kms'

export type DbWriter = PrismaClient | Prisma.TransactionClient

export interface EncryptFieldInput {
  ownerType: 'Contact' | 'SafeguardingFlag' | 'Interaction' | 'TrengoToken'
  ownerId: string
  fieldName: string
  plaintext: string
  ctx: {
    actorId: string | null
    requestId?: string
    purpose?: string
  }
}

export interface EncryptedFieldRow {
  id: string
  contactId: string
  column: string
  ciphertext: Buffer
  iv: Buffer
  dekCiphertext: Buffer
  aad: Buffer
  keyVersion: number
}

/**
 * Encrypt a field with KMS envelope encryption and persist it as an
 * EncryptedField row. Returns the row.
 *
 * The current EncryptedField table is keyed by `(contactId, column)`. We
 * accept any owner type in the AAD (so the binding survives moves of
 * encrypted data between owner kinds in future migrations) but persist
 * `ownerId` into `contactId` and `fieldName` into `column`. A future
 * migration may widen the model; AAD already captures the full identity.
 */
export async function encryptField(
  db: DbWriter,
  input: EncryptFieldInput,
): Promise<EncryptedFieldRow> {
  const { ownerType, ownerId, fieldName, plaintext, ctx } = input

  const kms = getKmsClient()
  const keyId = getKmsKeyId()

  const dataKey = await kms.send(
    new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }),
  )
  if (!dataKey.Plaintext || !dataKey.CiphertextBlob) {
    throw new Error('KMS GenerateDataKey returned no key material')
  }
  const dekPlain = Buffer.from(dataKey.Plaintext)
  const dekCiphertext = Buffer.from(dataKey.CiphertextBlob)

  const iv = randomBytes(12)
  const aad = Buffer.from(`${ownerType}|${ownerId}|${fieldName}|${KEY_VERSION}`, 'utf8')

  const cipher = createCipheriv('aes-256-gcm', dekPlain, iv)
  cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Standard convention: append the auth tag to the ciphertext.
  const ciphertext = Buffer.concat([enc, tag])

  // Zero the plaintext DEK as soon as we are done with it.
  dekPlain.fill(0)

  const id = createId()
  // Upsert so re-encrypts of the same field overwrite the previous row.
  const row = await db.encryptedField.upsert({
    where: {
      contactId_column: {
        contactId: ownerId,
        column: fieldName,
      },
    },
    create: {
      id,
      contactId: ownerId,
      column: fieldName,
      ciphertext,
      iv,
      dekCiphertext,
      aad,
      keyVersion: KEY_VERSION,
    },
    update: {
      ciphertext,
      iv,
      dekCiphertext,
      aad,
      keyVersion: KEY_VERSION,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'safeguarding.field_encrypted',
    target: { type: ownerType, id: ownerId },
    requestId: ctx.requestId,
    purpose: ctx.purpose,
    after: { fieldName, keyVersion: KEY_VERSION, encryptedFieldId: row.id },
  })

  return {
    id: row.id,
    contactId: row.contactId,
    column: row.column,
    ciphertext: Buffer.from(row.ciphertext),
    iv: Buffer.from(row.iv),
    dekCiphertext: Buffer.from(row.dekCiphertext),
    aad: Buffer.from(row.aad),
    keyVersion: row.keyVersion,
  }
}
