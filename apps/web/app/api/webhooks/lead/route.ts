// Lead capture webhook (Zapier and partners). See CLAUDE.md Section 16.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization')
  const expected = process.env['LEAD_WEBHOOK_TOKEN']
  if (!expected || auth !== `Bearer ${expected}`) {
    return new Response('unauthorised', { status: 401 })
  }
  // TODO: parse, persist as Lead row, return 2xx.
  return Response.json({ ok: true })
}
