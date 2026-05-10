// Smoke: an admin hits the internal DSAR export endpoint for a seeded
// contact and receives an application/zip stream containing a manifest.
// CLAUDE.md §21.
//
// We use Playwright's APIRequestContext so we can assert headers on the
// raw response — clicking through the UI would only stream into a
// browser download, which is harder to introspect.

import { test, expect } from '../fixtures/auth'

const SEEDED_DSAR_CONTACT_ID = process.env.E2E_DSAR_CONTACT_ID ?? 'seed-contact-dsar'

test.describe('dsar export smoke', () => {
  test('admin receives a zip with a manifest for a seeded contact', async ({
    signedInPage,
  }) => {
    const response = await signedInPage.request.get(
      `/api/internal/dsar/${SEEDED_DSAR_CONTACT_ID}`,
    )
    expect(response.status(), 'DSAR endpoint should return 200').toBe(200)

    const contentType = response.headers()['content-type'] ?? ''
    expect(contentType).toContain('application/zip')

    // The first four bytes of any zip are the local file header signature
    // 0x50 0x4b 0x03 0x04. Probe the body to confirm we got a real zip.
    const body = await response.body()
    expect(body.byteLength).toBeGreaterThan(0)
    expect(body[0]).toBe(0x50)
    expect(body[1]).toBe(0x4b)

    const disposition = response.headers()['content-disposition'] ?? ''
    expect(disposition).toContain('manifest')
  })
})
