// Effective Direct Debit recovery settings (ADR 0045 amendment). Loads the
// customisable singleton (Settings → DD recovery) and falls back to env / code
// defaults when the row is missing, so sends work before the row is seeded.
// The calculated CCJ court fee + statutory interest are fixed by law and are
// NOT settings — only the policy figures (late fee, cadence, response window,
// finance phone, letterhead) are.

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  DEBT_LETTER_RESPONSE_DAYS,
  DEFAULT_DD_LATE_FEE_MINOR,
  resolveDdLateFeeMinor,
} from '@studymind/core/finance'

type DbClient = PrismaClient | Prisma.TransactionClient

export interface EffectiveRecoverySettings {
  lateFeeMinor: number
  defaultCadenceDays: number
  responseDays: number
  financePhone: string
  companyName: string
  companyAddress: string
}

/** Fallback when the settings row hasn't been seeded yet (env, then defaults). */
export function fallbackRecoverySettings(): EffectiveRecoverySettings {
  return {
    lateFeeMinor: resolveDdLateFeeMinor(process.env.DD_LATE_FEE_GBP) || DEFAULT_DD_LATE_FEE_MINOR,
    defaultCadenceDays: 7,
    responseDays: DEBT_LETTER_RESPONSE_DAYS,
    financePhone: process.env.DD_FINANCE_PHONE ?? '020 3305 9593',
    companyName: 'Medic Mind',
    companyAddress: '16 Tottenhall Rd, London N13 6HX',
  }
}

export async function loadDdRecoverySettings(db: DbClient): Promise<EffectiveRecoverySettings> {
  const row = await db.ddRecoverySettings.findUnique({ where: { id: 'dd_recovery' } })
  if (!row) return fallbackRecoverySettings()
  return {
    lateFeeMinor: row.lateFeeMinor,
    defaultCadenceDays: row.defaultCadenceDays,
    responseDays: row.responseDays,
    financePhone: row.financePhone,
    companyName: row.companyName,
    companyAddress: row.companyAddress,
  }
}

/** Letterhead lines for the generated PDF from the settings. */
export function companyLetterhead(s: EffectiveRecoverySettings): {
  companyName: string
  companyLines: string[]
} {
  return {
    companyName: s.companyName,
    companyLines: [s.companyAddress, `Tel: ${s.financePhone}`],
  }
}
