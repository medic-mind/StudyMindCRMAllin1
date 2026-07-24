// Effective Direct Debit recovery settings (ADR 0045 amendment). Loads the
// customisable singleton (Settings → DD recovery) and falls back to env / code
// defaults when the row is missing, so sends work before the row is seeded.
// The calculated CCJ court fee + statutory interest are fixed by law and are
// NOT settings — only the policy figures (late fee, cadence, response window,
// finance phone, letterhead) are.

import type { Prisma, PrismaClient } from '@prisma/client'

import { DEBT_LETTER_RESPONSE_DAYS, resolveDdLateFeeMinor } from '@studymind/core/finance'

type DbClient = PrismaClient | Prisma.TransactionClient

export interface EffectiveRecoverySettings {
  lateFeeMinor: number
  defaultCadenceDays: number
  responseDays: number
  financePhone: string
  companyName: string
  companyAddress: string
  // Automatic chasing (operator opt-in) — read by the hourly engine to arm
  // new cases with no per-case human step. `DD_AUTO_CHASE=on` forces it on at
  // the platform level even before the row is edited.
  autoChaseEnabled: boolean
  autoChaseSetupLinkUrl: string | null
  autoChaseEmail: boolean
  autoChaseSms: boolean
}

/** Env can force auto-chase on/off regardless of the stored row. */
function envAutoChaseOverride(): boolean | null {
  const raw = process.env.DD_AUTO_CHASE?.trim().toLowerCase()
  if (raw === 'on' || raw === 'true' || raw === '1') return true
  if (raw === 'off' || raw === 'false' || raw === '0') return false
  return null
}

/** Fallback when the settings row hasn't been seeded yet (env, then defaults). */
export function fallbackRecoverySettings(): EffectiveRecoverySettings {
  return {
    // resolveDdLateFeeMinor already returns the default for missing/invalid
    // input; a configured "0" is a legitimate £0 fee, so no `|| default` here
    // (that would clobber 0 back to £12).
    lateFeeMinor: resolveDdLateFeeMinor(process.env.DD_LATE_FEE_GBP),
    defaultCadenceDays: 7,
    responseDays: DEBT_LETTER_RESPONSE_DAYS,
    financePhone: process.env.DD_FINANCE_PHONE ?? '020 3305 9593',
    companyName: 'Medic Mind',
    companyAddress: '16 Tottenhall Rd, London N13 6HX',
    autoChaseEnabled: envAutoChaseOverride() ?? false,
    autoChaseSetupLinkUrl: process.env.DD_AUTO_CHASE_LINK?.trim() || null,
    autoChaseEmail: true,
    autoChaseSms: false,
  }
}

export async function loadDdRecoverySettings(db: DbClient): Promise<EffectiveRecoverySettings> {
  const row = await db.ddRecoverySettings.findUnique({ where: { id: 'dd_recovery' } })
  if (!row) return fallbackRecoverySettings()
  const envOverride = envAutoChaseOverride()
  return {
    lateFeeMinor: row.lateFeeMinor,
    defaultCadenceDays: row.defaultCadenceDays,
    responseDays: row.responseDays,
    financePhone: row.financePhone,
    companyName: row.companyName,
    companyAddress: row.companyAddress,
    autoChaseEnabled: envOverride ?? row.autoChaseEnabled,
    autoChaseSetupLinkUrl:
      row.autoChaseSetupLinkUrl?.trim() || process.env.DD_AUTO_CHASE_LINK?.trim() || null,
    autoChaseEmail: row.autoChaseEmail,
    autoChaseSms: row.autoChaseSms,
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
