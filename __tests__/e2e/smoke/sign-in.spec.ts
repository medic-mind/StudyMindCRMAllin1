// Smoke: an unauthenticated visitor is redirected to sign-in,
// can complete the Clerk form using a seeded dev user, and lands in
// the authenticated app shell. Also runs an axe-core a11y scan on the
// authenticated shell, excluding the third-party Clerk iframe (CLAUDE.md
// §28: we exclude provider iframes from our own a11y budget).

import AxeBuilder from '@axe-core/playwright'

import { test, expect } from '../fixtures/auth'

test.describe('sign-in smoke', () => {
  test('unauthenticated visitor is redirected to sign-in', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL(/\/sign-in/, { timeout: 15_000 })
    await expect(page).toHaveURL(/\/sign-in/)
  })

  test('seeded user can sign in and reach the app shell', async ({ signedInPage }) => {
    // The fixture itself performs sign-in. Just assert we are inside the
    // authenticated shell — the sidebar advertises the product name.
    await signedInPage.goto('/contacts')
    await expect(signedInPage.getByText('StudyMind CRM').first()).toBeVisible()
    await expect(signedInPage.getByRole('heading', { name: /contacts/i })).toBeVisible()

    // CLAUDE.md §28: zero axe violations on critical pages. We exclude
    // `iframe` because Clerk renders its own UI in one and we do not own
    // its DOM.
    const results = await new AxeBuilder({ page: signedInPage }).exclude('iframe').analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })
})
