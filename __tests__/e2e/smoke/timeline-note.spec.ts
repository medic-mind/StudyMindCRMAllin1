// Smoke: signed-in user creates a Contact, posts a note via the inline
// AddNote form, and sees the note appear at the top of the timeline.

import { test, expect } from '../fixtures/auth'
import { randomContactInput, randomNoteInput } from '../fixtures/factory'

test.describe('timeline note smoke', () => {
  test('agent posts a note and it appears on the timeline', async ({ signedInPage }) => {
    const contact = randomContactInput()
    const note = randomNoteInput()

    // Arrange: create a fresh contact for this spec (no order coupling).
    await signedInPage.goto('/contacts/new')
    await signedInPage.getByLabel(/role/i).selectOption('parent')
    await signedInPage.getByLabel(/first name/i).fill(contact.firstName)
    await signedInPage.getByLabel(/last name/i).fill(contact.lastName)
    await signedInPage.getByLabel(/email/i).fill(contact.email)
    await signedInPage.getByLabel(/phone/i).fill(contact.phoneE164)
    await signedInPage.getByRole('button', { name: /create contact/i }).click()
    await signedInPage.waitForURL(/\/contacts\/[a-z0-9]+$/i, { timeout: 15_000 })

    // Act: fill and submit the AddNote form.
    await signedInPage.getByLabel(/^summary$/i).fill(note.summary)
    await signedInPage.getByLabel(/^note$/i).fill(note.body)
    await signedInPage.getByRole('button', { name: /add note/i }).click()

    // Assert: the new note appears at the top of the timeline within 3s.
    const timeline = signedInPage.getByRole('list').first()
    await expect(timeline.getByText(note.summary)).toBeVisible({ timeout: 3_000 })
  })
})
