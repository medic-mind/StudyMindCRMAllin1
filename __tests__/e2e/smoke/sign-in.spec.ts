// Smoke: an unauthenticated visitor is redirected to sign-in,
// can complete the Clerk form using a seeded dev user, and lands in
// the authenticated app shell.

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
  })
})
