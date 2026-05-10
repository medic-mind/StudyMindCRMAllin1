// Playwright fixture for an authenticated browser session.
//
// ADR 0010: signs in via the self-hosted credentials form (NextAuth v5).
// Required env:
//   - E2E_USER_EMAIL     (default: agent@dev.studymind)
//   - E2E_USER_PASSWORD  (no default; must be supplied via CI secret or
//                         1Password vault "StudyMind CRM Dev")
//
// TODO(chunk-10): the seed script does not yet create the Aashir
// super-admin user with a known password. Until then, set the env above
// to a seeded test user that exists in the local dev DB.

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
    await page.getByLabel(/email/i).fill(email)
    await page.getByLabel(/password/i).fill(password)
    await page.getByRole('button', { name: /sign in/i }).click()

    // Land on the authenticated shell — Contacts is a safe default.
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 30_000 })
    await expect(page.getByText('StudyMind CRM').first()).toBeVisible({ timeout: 15_000 })

    await use(page)
  },
})

export { expect }
