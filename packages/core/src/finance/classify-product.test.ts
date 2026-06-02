import { describe, expect, it } from 'vitest'

import {
  classifyProductFromText,
  resolveAiProductSuggestion,
  type ProductCatalogueEntry,
} from './classify-product'

const catalogue: ProductCatalogueEntry[] = [
  { handle: 'ucat-course', name: 'UCAT Crash Course', category: 'UCAT', aliases: ['ucat', 'u cat'] },
  {
    handle: 'mmi-interview',
    name: 'MMI Interview Prep',
    category: 'Interview',
    aliases: ['interview prep', 'mmi'],
  },
  { handle: 'gcse-maths', name: 'GCSE Maths Tutoring', category: 'Tutoring', aliases: ['maths tuition'] },
]

describe('classifyProductFromText', () => {
  it('matches by product name', () => {
    const result = classifyProductFromText('Payment for UCAT Crash Course', catalogue)
    expect(result.productHandles).toEqual(['ucat-course'])
    expect(result.categories).toEqual(['UCAT'])
    expect(result.unmatched).toBe(false)
  })

  it('matches by alias', () => {
    const result = classifyProductFromText('mmi block booking', catalogue)
    expect(result.productHandles).toEqual(['mmi-interview'])
  })

  it('matches multiple distinct products without duplication', () => {
    const result = classifyProductFromText('UCAT and interview prep bundle', catalogue)
    expect(result.productHandles.sort()).toEqual(['mmi-interview', 'ucat-course'])
  })

  it('does not match substrings across word boundaries', () => {
    // "ucategory" must not trip the "ucat" alias.
    const result = classifyProductFromText('ucategorised payment', catalogue)
    expect(result.unmatched).toBe(true)
  })

  it('reports unmatched for unknown descriptions', () => {
    const result = classifyProductFromText('Mystery one-off charge', catalogue)
    expect(result.productHandles).toEqual([])
    expect(result.unmatched).toBe(true)
  })
})

describe('resolveAiProductSuggestion', () => {
  const handles = ['ucat-course', 'mmi-interview', 'gcse-maths']

  it('accepts a confident, in-catalogue handle', () => {
    const result = resolveAiProductSuggestion(
      { productHandle: 'ucat-course', confidence: 0.9, reason: 'mentions UCAT' },
      handles,
    )
    expect(result).toEqual({ handle: 'ucat-course', confidence: 0.9, reason: 'mentions UCAT' })
  })

  it('rejects a handle not in the catalogue (fail closed — never invents)', () => {
    const result = resolveAiProductSuggestion(
      { productHandle: 'made-up-course', confidence: 0.99, reason: 'hallucination' },
      handles,
    )
    expect(result).toBeNull()
  })

  it('rejects a low-confidence suggestion', () => {
    const result = resolveAiProductSuggestion(
      { productHandle: 'ucat-course', confidence: 0.5, reason: 'maybe' },
      handles,
    )
    expect(result).toBeNull()
  })

  it('rejects a null handle', () => {
    const result = resolveAiProductSuggestion(
      { productHandle: null, confidence: 0.9, reason: 'no fit' },
      handles,
    )
    expect(result).toBeNull()
  })

  it('honours a custom threshold', () => {
    const result = resolveAiProductSuggestion(
      { productHandle: 'gcse-maths', confidence: 0.6, reason: 'maths' },
      handles,
      0.55,
    )
    expect(result?.handle).toBe('gcse-maths')
  })
})
