// Smoke: a signed-in user creates a parent Contact from /contacts/new
// and lands on the detail page with the contact's name in the header.

import { test, expect } from '../fixtures/auth'
import { randomContactInput } from '../fixtures/factory'

test.describe('create contact smoke', () => {
  test('agent creates a parent contact and sees the detail page', async ({ signedInPage }) => {
    const input = randomContactInput()

    await signedInPage.goto('/contacts')
    await signedInPage.getByRole('link', { name: /new contact/i }).click()

    await signedInPage.waitForURL(/\/contacts\/new/, { timeout: 10_000 })

    // Role select defaults to 'parent' — set explicitly to keep the test
    // resilient to default-value changes.
    await signedInPage.getByLabel(/role/i).selectOption('parent')
    await signedInPage.getByLabel(/first name/i).fill(input.firstName)
    await signedInPage.getByLabel(/last name/i).fill(input.lastName)
    await signedInPage.getByLabel(/email/i).fill(input.email)
    await signedInPage.getByLabel(/phone/i).fill(input.phoneE164)

    await signedInPage.getByRole('button', { name: /create contact/i }).click()

    // Redirect lands on /contacts/<cuid>
    await signedInPage.waitForURL(/\/contacts\/[a-z0-9]+$/i, { timeout: 15_000 })

    const fullName = `${input.firstName} ${input.lastName}`
    await expect(
      signedInPage.getByRole('heading', { level: 1, name: fullName }),
    ).toBeVisible({ timeout: 10_000 })
  })
})
