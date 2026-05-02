export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    sha: process.env['RAILWAY_GIT_COMMIT_SHA'] ?? null,
  })
}
