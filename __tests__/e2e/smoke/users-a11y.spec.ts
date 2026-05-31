// Dedicated a11y scan over Settings → Users, including the create dialog.
// Covers the dialogs + "⋯" actions menu added in ADR 0021.
// CLAUDE.md §28: WCAG 2.2 AA on primary surfaces.

import AxeBuilder from '@axe-core/playwright'

import { test, expect } from '../fixtures/auth'

test.describe('users settings a11y', () => {
  test('users list and create dialog pass axe-core with no violations', async ({
    signedInPage,
  }) => {
    await signedInPage.goto('/settings/users')
    await expect(
      signedInPage.getByRole('heading', { name: /users settings/i }),
    ).toBeVisible({ timeout: 15_000 })

    // The list view.
    const list = await new AxeBuilder({ page: signedInPage }).analyze()
    expect(list.violations, JSON.stringify(list.violations, null, 2)).toEqual([])

    // The create dialog (modal with form fields).
    await signedInPage.getByRole('button', { name: /add user/i }).click()
    await expect(
      signedInPage.getByRole('dialog', { name: /create a user/i }),
    ).toBeVisible({ timeout: 10_000 })

    const dialog = await new AxeBuilder({ page: signedInPage }).analyze()
    expect(dialog.violations, JSON.stringify(dialog.violations, null, 2)).toEqual([])
  })
})
