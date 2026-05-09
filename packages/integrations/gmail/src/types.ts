// Domain-mapped types for Gmail. CLAUDE.md §14.
//
// We do not propagate raw `googleapis` types beyond `client.ts`; the rest of
// the package and the rest of the app see normalised shapes only.

/** Inner payload of a Pub/Sub push from Gmail's `users.watch`. */
export interface GmailPushNotification {
  emailAddress: string
  historyId: string
}

/** Outer Pub/Sub push envelope. */
export interface PubSubPushBody {
  message: {
    /** Base64-encoded JSON; decode then JSON.parse to get GmailPushNotification. */
    data: string
    messageId: string
    publishTime: string
    attributes?: Record<string, string>
  }
  subscription: string
}
