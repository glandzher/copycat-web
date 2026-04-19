'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

type SharedLink = {
  id: string
  file_id: string
  file_name: string
  created_at: string
  view_count: number
  last_viewed_at: string | null
  last_viewed_country: string | null
}

const FLAG: Record<string, string> = {
  US:'🇺🇸', GB:'🇬🇧', FR:'🇫🇷', DE:'🇩🇪', CH:'🇨🇭', CA:'🇨🇦',
  AU:'🇦🇺', JP:'🇯🇵', IN:'🇮🇳', BR:'🇧🇷', ES:'🇪🇸', IT:'🇮🇹', NL:'🇳🇱',
}

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)   return 'just now'
  if (s < 3600)  return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return `${Math.floor(s/86400)}d ago`
}

export default function Dashboard() {
  const router = useRouter()
  const [user, setUser]       = useState<User | null>(null)
  const [links, setLinks]     = useState<SharedLink[]>([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied]   = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) { router.push('/login'); return }
      setUser(data.user)
      loadLinks(data.user.id)
    })
  }, [router])

  async function loadLinks(userId: string) {
    // Join shared_links with view counts from views table
    const { data } = await supabase
      .from('shared_links')
      .select(`
        id, file_id, file_name, created_at,
        views:views(count, last_viewed_at:viewed_at.max(), last_viewed_country:country.last())
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    setLinks(
      (data ?? []).map((r: any) => ({
        id:                  r.id,
        file_id:             r.file_id,
        file_name:           r.file_name,
        created_at:          r.created_at,
        view_count:          r.views?.[0]?.count ?? 0,
        last_viewed_at:      r.views?.[0]?.last_viewed_at ?? null,
        last_viewed_country: r.views?.[0]?.last_viewed_country ?? null,
      }))
    )
    setLoading(false)
  }

  function copyLink(fileId: string) {
    const url = `${location.origin}/view?id=${fileId}`
    navigator.clipboard.writeText(url)
    setCopied(fileId)
    setTimeout(() => setCopied(null), 2000)
  }

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/')
  }

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Nav */}
      <nav className="bg-white border-b border-gray-100 px-8 py-4 flex items-center justify-between">
        <a href="/" className="text-brand-600 font-bold text-xl tracking-tight">Copycat</a>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user?.email}</span>
          <button
            onClick={signOut}
            className="text-sm text-gray-500 hover:text-gray-900 font-medium transition-colors"
          >
            Sign out
          </button>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-10 flex flex-col gap-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Recordings</h1>
            <p className="text-sm text-gray-500 mt-1">
              {links.length === 0 ? 'No shared recordings yet' : `${links.length} shared recording${links.length > 1 ? 's' : ''}`}
            </p>
          </div>
        </div>

        {links.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-16 text-center flex flex-col items-center gap-4">
            <span className="text-5xl">🎬</span>
            <h2 className="text-lg font-semibold text-gray-700">No recordings shared yet</h2>
            <p className="text-sm text-gray-400 max-w-sm">
              Record a video with the Copycat Chrome extension and click
              &ldquo;Share&rdquo; — it will appear here with live view analytics.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {links.map(link => (
              <div
                key={link.id}
                className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center gap-4 hover:border-brand-200 transition-colors"
              >
                {/* Thumbnail placeholder */}
                <div className="w-24 h-14 bg-gray-100 rounded-lg flex-shrink-0 flex items-center justify-center text-2xl">
                  🎬
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{link.file_name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Shared {timeAgo(link.created_at)}
                  </p>
                  <div className="flex items-center gap-3 mt-2">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                      link.view_count > 0
                        ? 'bg-green-50 text-green-700'
                        : 'bg-gray-100 text-gray-500'
                    }`}>
                      {link.view_count} {link.view_count === 1 ? 'view' : 'views'}
                    </span>
                    {link.last_viewed_at && (
                      <span className="text-xs text-gray-400">
                        Last viewed {timeAgo(link.last_viewed_at)}
                        {link.last_viewed_country && (
                          <> · {FLAG[link.last_viewed_country] ?? '🌍'} {link.last_viewed_country}</>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <a
                    href={`/view?id=${link.file_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-gray-600 hover:text-brand-600 border border-gray-200 hover:border-brand-200 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Preview
                  </a>
                  <button
                    onClick={() => copyLink(link.file_id)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                      copied === link.file_id
                        ? 'bg-green-500 text-white border-transparent'
                        : 'bg-brand-600 hover:bg-brand-700 text-white'
                    }`}
                  >
                    {copied === link.file_id ? '✓ Copied!' : 'Copy link'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
