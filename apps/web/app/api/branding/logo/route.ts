// Serves the custom brand logo bytes (CLAUDE.md §4). Public: the logo is the
// org's own non-sensitive artwork and must render on the unauthenticated
// sign-in page. Returns 404 when no logo is set so the UI falls back to the
// inline SVG mark. Callers append ?v=<version> to cache-bust on change.

import { NextResponse } from 'next/server'

import { getBrandingLogoBytes } from '@studymind/core/branding'

import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const logo = await getBrandingLogoBytes(db)
  if (!logo) {
    return new NextResponse(null, { status: 404 })
  }
  return new NextResponse(logo.data as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': logo.contentType,
      'Cache-Control': 'public, max-age=300, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
