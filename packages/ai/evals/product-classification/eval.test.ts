// Schema-only eval for product-classification. CLAUDE.md §18.3.

import { describe, expect, it } from 'vitest'

import {
  buildProductClassificationPrompt,
  productClassificationSchema,
  type ProductClassificationAi,
  type ProductClassificationPromptInput,
} from '../../src/prompts/product-classification'
import { loadFixtures } from '../run'

const fixtures = loadFixtures<ProductClassificationPromptInput, ProductClassificationAi>(__dirname)

describe('product-classification eval (schema)', () => {
  for (const f of fixtures) {
    it(`fixture ${f.name}: prompt builds and expected parses`, () => {
      const prompt = buildProductClassificationPrompt(f.input)
      // The catalogue must appear in the prompt so the model can only pick a
      // handle we actually offer.
      for (const option of f.input.catalogue) {
        expect(prompt.user).toContain(option.handle)
      }
      const parsed = productClassificationSchema.parse(f.expected)
      // A non-null suggestion must reference a catalogue handle (never invented).
      if (parsed.productHandle !== null) {
        expect(f.input.catalogue.map((c) => c.handle)).toContain(parsed.productHandle)
      }
    })
  }
})
