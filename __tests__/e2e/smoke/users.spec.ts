// Smoke: an admin (CEO/Senior Manager — the seeded e2e user) opens
// Settings → Users, creates an account, and is shown the one-time temporary
// password to share. ADR 0021, CLAUDE.md §20.
//
// Account creation writes a real User row; preview DBs reset on each push so
// a timestamped email keeps the run idempotent.

import { test, expect } from '../fixtures/auth'

test.describe('user management smoke', () => {
  test('admin creates a user and sees the temporary login details', async ({ signedInPage }) => {
    await signedInPage.goto('/settings/users')

    // The management surface (not the "no permission" message) is shown to an
    // admin: the page heading and the "Add user" button are present.
    await expect(
      signedInPage.getByRole('heading', { name: /users settings/i }),
    ).toBeVisible({ timeout: 15_000 })

    await signedInPage.getByRole('button', { name: /add user/i }).click()

    const dialog = signedInPage.getByRole('dialog', { name: /create a user/i })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    const email = `e2e-user-${Date.now()}@dev.studymind`
    await dialog.getByLabel(/email/i).fill(email)
    await dialog.getByLabel(/name/i).fill('E2E Test User')
    // Virtual Assistant is grantable by every admin role.
    await dialog.getByRole('checkbox', { name: /virtual assistant/i }).check()

    await dialog.getByRole('button', { name: /create user/i }).click()

    // The success view reveals the credentials with a one-time temp password
    // and a copy-all affordance.
    await expect(signedInPage.getByText(/account created/i)).toBeVisible({ timeout: 15_000 })
    await expect(signedInPage.getByText(/temporary password/i)).toBeVisible()
    await expect(
      signedInPage.getByRole('button', { name: /copy all login details/i }),
    ).toBeVisible()
    await expect(signedInPage.getByText(email)).toBeVisible()

    await signedInPage.getByRole('button', { name: /^done$/i }).click()

    // The new user now appears in the list.
    await expect(signedInPage.getByText(email)).toBeVisible({ timeout: 10_000 })
  })
})
