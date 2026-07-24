// Maps a raw tRPC HTTP response (status + content-type) to ONE clean,
// actionable message — or null to let the response pass through to tRPC.
//
// Two failure classes otherwise reach the user as opaque tRPC-client errors:
//  - a NON-JSON body (a Railway/proxy gateway page during a worker restart, a
//    framework 500 HTML page, or an auth redirect that resolved to a page) →
//    tRPC JSON-parses HTML into "Unexpected token '<', <!DOCTYPE … not valid
//    JSON".
//  - a 401 whose JSON body is NOT a tRPC error envelope. The auth middleware
//    returns a bare `{ error: 'unauthorized' }` (application/json) when the
//    session is missing/expired; that isn't tRPC-shaped, so the client throws
//    the opaque "Unable to transform response from server" instead of telling
//    the user their session lapsed.
//
// A normal tRPC response — a success OR tRPC's OWN error envelope (BAD_REQUEST
// 400, FORBIDDEN 403, CONFLICT 409, INTERNAL_SERVER_ERROR 500 …) — is
// application/json and MUST pass through untouched so the client surfaces the
// server's real message. Only the two classes above are intercepted.

export function trpcResponseError(status: number, contentType: string): string | null {
  const sessionMsg = 'Your session may have expired — please refresh the page or sign in again.'

  // A 401 always means "not authenticated", whatever the body shape. Intercept
  // it before the transformer chokes on a non-tRPC body. (No client path relies
  // on catching a tRPC UNAUTHORIZED, so this is safe for real tRPC 401s too.)
  if (status === 401) return sessionMsg

  // Any other proper JSON response (success or a tRPC error envelope) passes
  // through so the client shows the server's own message.
  if (contentType.includes('application/json')) return null

  // Non-JSON bodies would JSON-parse-fail; map them by status instead.
  if (status >= 500) return `The server had a problem (${status}). Please try again in a moment.`
  if (status === 403) return sessionMsg
  return `Something went wrong (${status || 'network'}). Please try again.`
}
