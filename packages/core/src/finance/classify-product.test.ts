import { describe, expect, it } from 'vitest'

import { classifyProductFromText, type ProductCatalogueEntry } from './classify-product'

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
