import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'edge'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)

export async function POST(req: NextRequest) {
  try {
    const { fileId } = await req.json()
    if (!fileId || typeof fileId !== 'string') {
      return NextResponse.json({ error: 'Missing fileId' }, { status: 400 })
    }

    // Geo info from Vercel edge headers (populated automatically on Vercel)
    const country  = req.headers.get('x-vercel-ip-country') ?? 'unknown'
    const city     = req.headers.get('x-vercel-ip-city') ?? null
    const referrer = req.headers.get('referer') ?? null

    // Hash the IP for privacy (we store country/city but not raw IP)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? ''
    const ipHash = ip
      ? Buffer.from(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
        ).toString('hex').slice(0, 16)
      : null

    const { error } = await supabase.from('views').insert({
      file_id:  fileId,
      country,
      city,
      referrer,
      ip_hash:  ipHash,
    })

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[track]', e?.message)
    return NextResponse.json({ error: 'Failed to log view' }, { status: 500 })
  }
}
