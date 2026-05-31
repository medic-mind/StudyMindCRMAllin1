// Public surface for the in-process realtime bus. ADR 0020 Phase 3.
export * from './bus'
// Internal team-messaging realtime bus (ADR 0022) — a sibling on its own
// emitter + Redis channel so chat traffic never crosses the conversation bus.
export * from './chat-bus'
