// Smoke: an admin reviews the open reconciliation discrepancies,
// resolves one with a rationale, and the row moves out of the open list.
// CLAUDE.md §23.

import { test, expect } from '../fixtures/auth'

test.describe('reconciliation review smoke', () => {
  test('admin resolves a discrepancy with a rationale', async ({ signedInPage }) => {
    await signedInPage.goto('/finance/reconciliation')
    await expect(
      signedInPage.getByRole('heading', { name: /reconciliation/i }),
    ).toBeVisible()

    // Capture the first open row's identifier so we can re-check it disappeared.
    const firstRow = signedInPage.getByRole('row').nth(1)
    const rowText = (await firstRow.innerText()).trim()

    await firstRow.getByRole('button', { name: /resolve with rationale/i }).click()

    await signedInPage
      .getByLabel(/rationale/i)
      .fill('Verified against Stripe export — over-collection refunded manually.')
    await signedInPage.getByRole('button', { name: /^confirm$/i }).click()

    // The resolved row no longer appears in the open list.
    await expect(signedInPage.getByText(rowText)).toBeHidden({ timeout: 10_000 })
  })
})
