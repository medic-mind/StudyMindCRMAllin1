// Dedicated a11y scan over the contacts list — no exclusions.
// CLAUDE.md §28: WCAG 2.2 AA on primary surfaces.

import AxeBuilder from '@axe-core/playwright'

import { test, expect } from '../fixtures/auth'

test.describe('contacts list a11y', () => {
  test('contacts list passes axe-core with no violations', async ({ signedInPage }) => {
    await signedInPage.goto('/contacts')
    await expect(
      signedInPage.getByRole('heading', { name: /contacts/i }),
    ).toBeVisible()

    const results = await new AxeBuilder({ page: signedInPage }).analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })
})
