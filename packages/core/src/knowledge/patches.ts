// Patch engine for in-app knowledge edits (ADR 0040). The AI editor
// proposes patches in the Crib's dot-path format; a human confirms; this
// module applies them — pure, fail-closed, never in place. The one
// universal Crib content rule (no Zoom/Teams links, IDs or passcodes) is
// enforced on every incoming value.

import { z } from 'zod'

import { BusinessError } from '../errors'
import type { KnowledgePatch, KnowledgeValue } from './types'

const knowledgeValueSchema: z.ZodType<KnowledgeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(knowledgeValueSchema),
    z.record(knowledgeValueSchema),
  ]),
)

export const knowledgePatchSchema: z.ZodType<KnowledgePatch> = z.object({
  op: z.enum(['replace', 'add', 'remove']),
  /** Dot path, e.g. `fullApplication.tiers.3.hours`. `-` appends to an array. */
  path: z.string().trim().min(1).max(500),
  value: knowledgeValueSchema.optional(),
})

/** Hard ceiling on the serialised document after edits (~3x the baseline). */
export const MAX_KNOWLEDGE_DOCUMENT_CHARS = 1_500_000

// The Crib's one universal hard rule, applied to every incoming value:
// meeting links flow to paid students via the booking system only.
const FORBIDDEN_CONTENT = /zoom\.us|teams\.microsoft\.com|passcode/i

function assertValueAllowed(patch: KnowledgePatch): void {
  if (patch.value === undefined) return
  if (FORBIDDEN_CONTENT.test(JSON.stringify(patch.value))) {
    throw new BusinessError(
      'KNOWLEDGE_CONTENT_FORBIDDEN',
      `Patch for "${patch.path}" contains a Zoom/Teams link, meeting ID or passcode — those never go in the knowledge base.`,
      { path: patch.path },
    )
  }
}

function invalid(patch: KnowledgePatch, reason: string): BusinessError {
  return new BusinessError(
    'KNOWLEDGE_PATCH_INVALID',
    `Cannot ${patch.op} "${patch.path}": ${reason}`,
    { op: patch.op, path: patch.path },
  )
}

interface ResolvedParent {
  parent: KnowledgeValue[] | { [key: string]: KnowledgeValue }
  /** Final path segment — an object key, an array index, or `-` (append). */
  leaf: string
}

function isObject(value: KnowledgeValue | undefined): value is { [key: string]: KnowledgeValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stepInto(
  container: KnowledgeValue | undefined,
  segment: string,
): KnowledgeValue | undefined {
  if (Array.isArray(container)) {
    if (!/^\d+$/.test(segment)) return undefined
    return container[Number(segment)]
  }
  if (isObject(container)) return container[segment]
  return undefined
}

function resolveParent(
  root: { [key: string]: KnowledgeValue },
  patch: KnowledgePatch,
): ResolvedParent {
  const segments = patch.path.split('.')
  const leaf = segments[segments.length - 1]
  if (!leaf) throw invalid(patch, 'empty path segment')

  let cursor: KnowledgeValue = root
  for (const segment of segments.slice(0, -1)) {
    const next = stepInto(cursor, segment)
    if (next === undefined || next === null || typeof next !== 'object') {
      throw invalid(patch, `"${segment}" does not exist or is not a container`)
    }
    cursor = next
  }
  if (!Array.isArray(cursor) && !isObject(cursor)) {
    throw invalid(patch, 'parent is not an object or array')
  }
  return { parent: cursor, leaf }
}

function applyOne(root: { [key: string]: KnowledgeValue }, patch: KnowledgePatch): void {
  assertValueAllowed(patch)
  const { parent, leaf } = resolveParent(root, patch)

  if (Array.isArray(parent)) {
    const isAppend = leaf === '-' || Number(leaf) === parent.length
    if (leaf !== '-' && !/^\d+$/.test(leaf)) {
      throw invalid(patch, 'array index must be a number (or "-" to append)')
    }
    const index = leaf === '-' ? parent.length : Number(leaf)
    switch (patch.op) {
      case 'replace':
        if (index >= parent.length) throw invalid(patch, `index ${index} is out of range`)
        if (patch.value === undefined) throw invalid(patch, 'replace needs a value')
        parent[index] = patch.value
        return
      case 'add':
        if (!isAppend && index > parent.length) {
          throw invalid(patch, `index ${index} is beyond the end of the array`)
        }
        if (patch.value === undefined) throw invalid(patch, 'add needs a value')
        parent.splice(index, 0, patch.value)
        return
      case 'remove':
        if (leaf === '-' || index >= parent.length) {
          throw invalid(patch, `index ${leaf} does not exist`)
        }
        parent.splice(index, 1)
        return
    }
  }

  switch (patch.op) {
    case 'replace':
      if (!(leaf in parent)) throw invalid(patch, `key "${leaf}" does not exist (use add)`)
      if (patch.value === undefined) throw invalid(patch, 'replace needs a value')
      parent[leaf] = patch.value
      return
    case 'add':
      if (leaf in parent) throw invalid(patch, `key "${leaf}" already exists (use replace)`)
      if (patch.value === undefined) throw invalid(patch, 'add needs a value')
      parent[leaf] = patch.value
      return
    case 'remove':
      if (!(leaf in parent)) throw invalid(patch, `key "${leaf}" does not exist`)
      delete parent[leaf]
      return
  }
}

/**
 * Applies patches to a knowledge document and returns the NEW document —
 * the input is never mutated. Throws `KNOWLEDGE_PATCH_INVALID` /
 * `KNOWLEDGE_CONTENT_FORBIDDEN` on the first bad patch (all-or-nothing).
 */
export function applyKnowledgePatches(
  data: Readonly<Record<string, KnowledgeValue>>,
  patches: readonly KnowledgePatch[],
): Record<string, KnowledgeValue> {
  if (patches.length === 0) {
    throw new BusinessError('KNOWLEDGE_PATCH_INVALID', 'No patches to apply.')
  }
  const next = structuredClone(data) as Record<string, KnowledgeValue>
  for (const patch of patches) {
    applyOne(next, patch)
  }
  const size = JSON.stringify(next).length
  if (size > MAX_KNOWLEDGE_DOCUMENT_CHARS) {
    throw new BusinessError(
      'KNOWLEDGE_PATCH_INVALID',
      `The edited knowledge base would be ${size} characters — over the ${MAX_KNOWLEDGE_DOCUMENT_CHARS} ceiling.`,
    )
  }
  return next
}

/** The current value at a dot path, for review UIs ("old → new"). */
export function getAtPath(
  data: Readonly<Record<string, KnowledgeValue>>,
  path: string,
): { found: boolean; value?: KnowledgeValue } {
  let cursor: KnowledgeValue | undefined = data
  for (const segment of path.split('.')) {
    if (segment === '-') return { found: false }
    cursor = stepInto(cursor, segment)
    if (cursor === undefined) return { found: false }
  }
  return { found: true, value: cursor }
}
