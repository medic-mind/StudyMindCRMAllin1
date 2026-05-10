// Versioned alias for the lead webhook. CLAUDE.md §16 says we must
// expose `/v2` for forward compatibility — we do, but today it is the
// same handler as v1. When we genuinely need a breaking change, this
// route gets its own implementation; v1 stays alive for 12 months.
//
// Next.js does not recognise re-exported route segment config, so
// `runtime` and `dynamic` must be declared inline here in addition to
// the v1 file.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export { POST } from '../route'
