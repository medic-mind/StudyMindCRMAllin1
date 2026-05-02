// Outbound calls TO Gmail.
// Idempotency keys per CLAUDE.md Section 17.

export interface OutboundContext {
  actorId: string
  requestId: string
}

export async function ping(_ctx: OutboundContext): Promise<void> {
  throw new Error('not implemented')
}
