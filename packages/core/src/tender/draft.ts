// Tender draft request — calls into @studymind/ai/prompts/tender/draft and
// persists the result as a TenderDraftRequest row in `pending` signoff.
// See CLAUDE.md §43.1 (drafts) and §35 (drafts are explicitly labelled
// pending review until human signoff).

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

type DbWriter = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}

export interface RequestTenderDraftInput {
  tenderId: string
  brief: string
  sectionsToDraft?: ReadonlyArray<string>
  requesterId: string
}

export interface RequestTenderDraftResult {
  draftId: string
  draftText: string
  promptVersion: string
}

export interface TenderDraftRunner {
  (input: {
    laName: string
    commissioner: string | null
    brief: string
    sectionsToDraft: ReadonlyArray<string>
    isSemhOrEhcpHeavy: boolean
  }): Promise<{ text: string; promptVersion: string }>
}

/**
 * Generate a tender draft via the AI client and persist it for signoff.
 *
 * `runner` is injected so tests can stub the AI call. In production wire
 * this to `runTenderDraft` from `@studymind/ai/prompts/tender/draft`.
 *
 * The draft is stored at `signoffState='pending'` and explicitly labelled
 * "DRAFT — pending review" wherever it is shown until signoff completes.
 */
export async function requestTenderDraft(
  db: DbWriter,
  input: RequestTenderDraftInput,
  ctx: ActorCtx,
  runner: TenderDraftRunner,
): Promise<RequestTenderDraftResult> {
  const tender = await db.tender.findUniqueOrThrow({
    where: { id: input.tenderId },
    select: {
      id: true,
      laName: true,
      commissioner: true,
      isSemhOrEhcpHeavy: true,
      state: true,
    },
  })

  if (tender.state === 'awarded' || tender.state === 'rejected' || tender.state === 'withdrawn') {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Cannot draft for tender in terminal state ${tender.state}`,
    )
  }

  const result = await runner({
    laName: tender.laName,
    commissioner: tender.commissioner,
    brief: input.brief,
    sectionsToDraft: input.sectionsToDraft ?? [],
    isSemhOrEhcpHeavy: tender.isSemhOrEhcpHeavy,
  })

  const draftId = createId()
  await db.tenderDraftRequest.create({
    data: {
      id: draftId,
      tenderId: input.tenderId,
      brief: input.brief,
      sectionsToDraft: [...(input.sectionsToDraft ?? [])],
      draftText: result.text,
      promptVersion: result.promptVersion,
      signoffState: 'pending',
      requesterId: input.requesterId,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'tender.draft_requested',
    target: { type: 'TenderDraftRequest', id: draftId },
    requestId: ctx.requestId,
    after: {
      tenderId: input.tenderId,
      requesterId: input.requesterId,
      promptVersion: result.promptVersion,
      isSemhOrEhcpHeavy: tender.isSemhOrEhcpHeavy,
    },
  })

  return {
    draftId,
    draftText: result.text,
    promptVersion: result.promptVersion,
  }
}
