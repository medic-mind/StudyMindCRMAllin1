// Smoke: a finance user navigates to the refunds surface, opens the
// dialog against a seeded test payment, issues a small refund, and sees
// the resulting RefundIntent transition from `pending` to `succeeded`.
//
// Stripe is mocked at the SDK boundary in the dev server (see
// `packages/integrations/stripe/src/client.ts`); no live API call is made.
//
// CLAUDE.md §23 (E2E covers refund flow). The seed in `prisma/seed.ts`
// creates a `seed-test-payment` row that this spec targets.

import { test, expect } from '../fixtures/auth'

test.describe('refund smoke', () => {
  test('finance user issues a refund and the intent reaches succeeded', async ({
    signedInPage,
  }) => {
    await signedInPage.goto('/finance/refunds')
    await expect(signedInPage.getByRole('heading', { name: /refunds/i })).toBeVisible()

    // Open the refund dialog. The seed creates one payment tagged
    // "Seed test payment" so the row is stable across runs.
    await signedInPage
      .getByRole('row', { name: /seed test payment/i })
      .getByRole('button', { name: /refund/i })
      .click()

    // Fill the dialog: smallest legal amount, a recognisable reason.
    await signedInPage.getByLabel(/amount/i).fill('1.00')
    await signedInPage.getByLabel(/reason/i).selectOption('duplicate')
    await signedInPage.getByRole('button', { name: /issue refund/i }).click()

    // The dialog closes and the RefundIntent appears in the table.
    await expect(signedInPage.getByText(/pending/i).first()).toBeVisible({ timeout: 5_000 })
    await expect(signedInPage.getByText(/succeeded/i).first()).toBeVisible({
      timeout: 15_000,
    })
  })
})
