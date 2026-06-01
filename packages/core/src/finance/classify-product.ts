// Classify what a payment bought against the master product catalogue
// (ProductCatalogueItem). Deterministic and pure — the same phrase-match
// approach the lead classifier uses (ADR 0023), so a Stripe line-item
// description like "UCAT Crash Course" tags the `ucat-course` product without
// creating a duplicate product record. The job feeds in the active catalogue;
// this decides the matches.

export interface ProductCatalogueEntry {
  handle: string
  name: string
  category: string
  aliases: string[]
}

export interface ProductClassification {
  /** Catalogue handles that matched, deduped, in catalogue order. */
  productHandles: string[]
  /** Distinct categories of the matched products. */
  categories: string[]
  /** Human-readable rationale for the timeline / audit. */
  reason: string
  /** True when nothing matched — the payment is recorded but unclassified. */
  unmatched: boolean
}

/** Pad with single spaces around word-boundaried tokens for safe phrase hits. */
function padded(s: string): string {
  return ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()} `
}

function phraseHit(haystackPadded: string, needle: string): boolean {
  const n = needle
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!n) return false
  return haystackPadded.includes(` ${n} `)
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))]
}

/**
 * Match free text (Stripe line-item descriptions / product names) against the
 * active product catalogue. Never invents a product: an unmatched payment is
 * returned with `unmatched: true` for a human to label later.
 */
export function classifyProductFromText(
  text: string,
  catalogue: ProductCatalogueEntry[],
): ProductClassification {
  const hay = padded(text)
  const handles: string[] = []
  const categories: string[] = []

  for (const item of catalogue) {
    const needles = [item.handle, item.name, ...item.aliases]
    if (needles.some((n) => phraseHit(hay, n))) {
      handles.push(item.handle)
      categories.push(item.category)
    }
  }

  const productHandles = uniq(handles)
  const cats = uniq(categories)
  const unmatched = productHandles.length === 0

  return {
    productHandles,
    categories: cats,
    reason: unmatched
      ? 'No catalogue product matched the payment description'
      : `Matched products: ${productHandles.join(', ')}`,
    unmatched,
  }
}
