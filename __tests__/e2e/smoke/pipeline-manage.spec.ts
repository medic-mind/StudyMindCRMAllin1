// Smoke: a signed-in CEO or Senior Manager visits /pipeline/manage,
// sees the seeded default stages, adds a new stage, and the new column
// appears on the kanban.
//
// ADR 0015. Playwright is not part of the default CI gate; this spec
// compiles and runs against the dev server when invoked explicitly via
// `pnpm test:e2e`.

import { expect, test } from '../fixtures/auth'

test.describe('pipeline manage smoke', () => {
  test('admin can add a new pipeline stage', async ({ signedInPage }) => {
    await signedInPage.goto('/pipeline/manage')

    // The seeded defaults are rendered first.
    await expect(
      signedInPage.getByRole('heading', { name: /manage pipeline stages/i }),
    ).toBeVisible()

    const name = `E2E stage ${Date.now()}`
    await signedInPage.getByLabel(/name/i).first().fill(name)
    await signedInPage.getByRole('button', { name: /add stage/i }).click()

    // Refresh fires; the new stage should appear in the active list.
    await expect(signedInPage.getByText(name)).toBeVisible({ timeout: 10_000 })

    // And it should show up as a column on the kanban.
    await signedInPage.goto('/pipeline')
    await expect(
      signedInPage.getByRole('heading', { level: 2, name }),
    ).toBeVisible({ timeout: 10_000 })
  })
})
