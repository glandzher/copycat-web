'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import type { User, Session } from '@supabase/supabase-js'

// ── Types ─────────────────────────────────────────────────────────────────────

type DriveFile = {
  id: string
  name: string
  createdTime: string
  size: string
  thumbnailLink?: string
}

type ViewStats = {
  view_count: number
  last_viewed_at: string | null
  last_viewed_country: string | null
}

type Recording = DriveFile & {
  shared: boolean
  stats: ViewStats | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function fmtSize(bytes: string) {
  const n = parseInt(bytes || '0')
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function getDriveFiles(token: string): Promise<DriveFile[]> {
  // 1. Find the StepCapture folder
  const folderRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      "name='StepCapture' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    )}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!folderRes.ok) return []
  const folderData = await folderRes.json()
  const folder = folderData.files?.[0]
  if (!folder) return []

  // 2. List .webm files inside it
  const filesRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      `'${folder.id}' in parents and mimeType='video/webm' and trashed=false`
    )}&fields=files(id,name,createdTime,size,thumbnailLink)&orderBy=createdTime+desc&pageSize=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!filesRes.ok) return []
  const data = await filesRes.json()
  return data.files ?? []
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const router = useRouter()
  const [user, setUser]             = useState<User | null>(null)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading]       = useState(true)
  const [driveError, setDriveError] = useState(false)
  const [copied, setCopied]         = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) { router.push('/login'); return }
      setUser(session.user)
      await loadData(session)
    })
  }, [router])

  async function loadData(session: Session) {
    setLoading(true)

    // 1. Fetch Drive files using provider_token
    let driveFiles: DriveFile[] = []
    const token = session.provider_token
    if (token) {
      try {
        driveFiles = await getDriveFiles(token)
      } catch {
        setDriveError(true)
      }
    } else {
      setDriveError(true)
    }

    // 2. Fetch shared_links + view stats from Supabase
    const { data: links } = await supabase
      .from('shared_links')
      .select(`id, file_id, views:views(count, last_viewed_at:viewed_at.max(), last_viewed_country:country.last())`)
      .eq('user_id', session.user.id)

    const statsMap: Record<string, ViewStats> = {}
    const sharedFileIds = new Set<string>()
    ;(links ?? []).forEach((l: any) => {
      sharedFileIds.add(l.file_id)
      statsMap[l.file_id] = {
        view_count:          l.views?.[0]?.count ?? 0,
        last_viewed_at:      l.views?.[0]?.last_viewed_at ?? null,
        last_viewed_country: l.views?.[0]?.last_viewed_country ?? null,
      }
    })

    // 3. Merge: Drive files as primary source, stats for shared ones
    const merged: Recording[] = driveFiles.map(f => ({
      ...f,
      shared: sharedFileIds.has(f.id),
      stats:  statsMap[f.id] ?? null,
    }))

    setRecordings(merged)
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
          <button onClick={signOut} className="text-sm text-gray-500 hover:text-gray-900 font-medium transition-colors">
            Sign out
          </button>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6 py-10 flex flex-col gap-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Recordings</h1>
          <p className="text-sm text-gray-500 mt-1">
            {recordings.length === 0 ? 'No recordings yet'
              : `${recordings.length} recording${recordings.length > 1 ? 's' : ''}`}
          </p>
        </div>

        {/* Drive storage badge */}
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
          <svg width="20" height="18" viewBox="0 0 87.3 78" className="flex-shrink-0">
            <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
            <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
            <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
            <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
            <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
            <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
          </svg>
          <div>
            <p className="text-sm font-semibold text-blue-900">Stored in your Google Drive</p>
            <p className="text-xs text-blue-600">Your videos live in your own Drive — Copycat never stores your recordings.</p>
          </div>
        </div>

        {/* Drive auth warning */}
        {driveError && (
          <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 flex items-center gap-3">
            <span className="text-lg">⚠️</span>
            <div>
              <p className="text-sm font-semibold text-amber-900">Drive access expired</p>
              <p className="text-xs text-amber-700">
                <a href="/login" className="underline">Sign in again</a> to refresh your Google Drive connection.
              </p>
            </div>
          </div>
        )}

        {/* Recordings */}
        {recordings.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-16 text-center flex flex-col items-center gap-4">
            <span className="text-5xl">🎬</span>
            <h2 className="text-lg font-semibold text-gray-700">No recordings yet</h2>
            <p className="text-sm text-gray-400 max-w-sm">
              Record a video with the Copycat Chrome extension and save it to Google Drive —
              it will appear here automatically.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {recordings.map(rec => (
              <div key={rec.id}
                className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center gap-4 hover:border-brand-200 transition-colors">

                {/* Thumbnail */}
                <div className="w-24 h-14 bg-gray-100 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center">
                  {rec.thumbnailLink
                    ? <img src={rec.thumbnailLink} alt="" className="w-full h-full object-cover" />
                    : <span className="text-2xl">🎬</span>}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-gray-900 truncate">
                      {rec.name.replace(/\.webm$/i, '')}
                    </p>
                    <span className="flex-shrink-0 text-xs text-blue-400 font-medium">☁ Drive</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {timeAgo(rec.createdTime)} · {fmtSize(rec.size)}
                  </p>
                  <div className="flex items-center gap-3 mt-2">
                    {rec.shared ? (
                      <>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          (rec.stats?.view_count ?? 0) > 0
                            ? 'bg-green-50 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}>
                          {rec.stats?.view_count ?? 0} {rec.stats?.view_count === 1 ? 'view' : 'views'}
                        </span>
                        {rec.stats?.last_viewed_at && (
                          <span className="text-xs text-gray-400">
                            Last viewed {timeAgo(rec.stats.last_viewed_at)}
                            {rec.stats.last_viewed_country && (
                              <> · {FLAG[rec.stats.last_viewed_country] ?? '🌍'} {rec.stats.last_viewed_country}</>
                            )}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-gray-400 italic">Not shared yet</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <a href={`https://drive.google.com/file/d/${rec.id}/view`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-xs font-medium text-gray-600 hover:text-brand-600 border border-gray-200 hover:border-brand-200 px-3 py-1.5 rounded-lg transition-colors">
                    Drive ↗
                  </a>
                  <a href={`/view?id=${rec.id}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-xs font-medium text-gray-600 hover:text-brand-600 border border-gray-200 hover:border-brand-200 px-3 py-1.5 rounded-lg transition-colors">
                    Preview
                  </a>
                  <a href={`/edit?id=${rec.id}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 px-3 py-1.5 rounded-lg transition-colors">
                    🪄 Step Guide
                  </a>
                  <button
                    onClick={() => copyLink(rec.id)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                      copied === rec.id
                        ? 'bg-green-500 text-white'
                        : 'bg-brand-600 hover:bg-brand-700 text-white'
                    }`}>
                    {copied === rec.id ? '✓ Copied!' : 'Copy link'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-gray-400 pb-4">
          🔒 Your recordings are stored exclusively in your Google Drive. Copycat only tracks views for links you share.
        </p>
      </div>
    </div>
  )
}
