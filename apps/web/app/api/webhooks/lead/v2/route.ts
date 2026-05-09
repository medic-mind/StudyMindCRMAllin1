// Versioned alias for the lead webhook. CLAUDE.md §16 says we must
// expose `/v2` for forward compatibility — we do, but today it is the
// same handler as v1. When we genuinely need a breaking change, this
// route gets its own implementation; v1 stays alive for 12 months.

export { POST, runtime, dynamic } from '../route'
