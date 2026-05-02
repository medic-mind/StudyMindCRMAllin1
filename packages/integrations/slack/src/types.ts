// Domain-mapped types for Slack.
// We never let raw provider types leak into the rest of the app.

export interface SlackEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
