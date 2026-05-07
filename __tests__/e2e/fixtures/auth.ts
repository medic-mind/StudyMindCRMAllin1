// Playwright fixture for an authenticated browser session.
//
// We sign in through the Clerk-hosted sign-in form using a seeded dev user
// (CLAUDE.md §22 — `<role>@dev.studymind`). Required env:
//   - E2E_USER_EMAIL     (default: agent@dev.studymind)
//   - E2E_USER_PASSWORD  (no default; must be supplied via CI secret or
//                         1Password vault "StudyMind CRM Dev")
//
// We avoid Clerk's internal testing tokens here so the test exercises the
// real sign-in surface. Sign-up is out of scope for the smoke flow.

import { test as base, expect, type Page } from '@playwright/test'

interface AuthFixtures {
  signedInPage: Page
}

const DEFAULT_EMAIL = 'agent@dev.studymind'

export const test = base.extend<AuthFixtures>({
  signedInPage: async ({ page }, use) => {
    const email = process.env.E2E_USER_EMAIL ?? DEFAULT_EMAIL
    const password = process.env.E2E_USER_PASSWORD
    if (!password) {
      throw new Error(
        'E2E_USER_PASSWORD is required. Set it in CI secrets or your local .env.test.',
      )
    }

    await page.goto('/sign-in')

    // Clerk's <SignIn /> renders an email field, then a password step.
    await page.getByLabel(/email/i).fill(email)
    await page.getByRole('button', { name: /continue|next|sign in/i }).first().click()
    await page.getByLabel(/password/i).fill(password)
    await page.getByRole('button', { name: /continue|sign in/i }).first().click()

    // Land on the authenticated shell — Contacts is a safe default.
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 30_000 })
    await expect(page.getByText('StudyMind CRM').first()).toBeVisible({ timeout: 15_000 })

    await use(page)
  },
})

export { expect }
