// Smoke: a signed-in writer opens the default board and drags a card from its
// column onto another. The DnD interaction itself is hard to unit-test, so we
// exercise it here. ADR 0019. Playwright is not part of the default CI gate;
// this spec compiles and runs against the dev server when invoked explicitly
// via `pnpm test:e2e`.

import { expect, test } from '../fixtures/auth'

test.describe('board drag-and-drop smoke', () => {
  test('a card can be dragged into another column', async ({ signedInPage }) => {
    // Navigate to the default board (the /pipeline redirect lands here).
    await signedInPage.goto('/boards')
    await signedInPage.getByRole('link', { name: /open|view|board/i }).first().click()

    // Two columns must exist to have somewhere to drop.
    const columns = signedInPage.locator('section[aria-label$="column"]')
    await expect(columns.first()).toBeVisible({ timeout: 10_000 })
    const columnCount = await columns.count()
    test.skip(columnCount < 2, 'Need at least two stages to drag between columns')

    // The first card on the board acts as the drag source.
    const card = signedInPage.locator('li').filter({ has: signedInPage.locator('button') }).first()
    await expect(card).toBeVisible()
    const sourceText = (await card.innerText()).split('\n')[0]

    const targetColumn = columns.nth(1)
    const targetBox = await targetColumn.boundingBox()
    const cardBox = await card.boundingBox()
    if (!targetBox || !cardBox) throw new Error('Could not measure drag geometry')

    // Drag with intermediate moves so the 6px activation distance fires.
    await signedInPage.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
    await signedInPage.mouse.down()
    await signedInPage.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 60, {
      steps: 10,
    })
    await signedInPage.mouse.up()

    // The card should now be present in the target column. A move toast or a
    // refresh confirms the audited mutation ran.
    await expect(targetColumn.getByText(sourceText, { exact: false })).toBeVisible({
      timeout: 10_000,
    })

    // The keyboard-accessible fallback (the "Move to…" dropdown) must remain.
    await expect(
      signedInPage.getByRole('combobox', { name: /move card to another stage/i }).first(),
    ).toBeAttached()
  })
})
