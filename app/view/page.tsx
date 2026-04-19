'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

// Track the view via our Edge Function
async function trackView(fileId: string) {
  try {
    await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
  } catch (_) {}
}

// Fetch video metadata from Google Drive public API
async function fetchDriveMeta(fileId: string) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size&key=${process.env.NEXT_PUBLIC_GOOGLE_API_KEY || ''}`,
  )
  if (!res.ok) return null
  return res.json()
}

function VideoViewer() {
  const params   = useSearchParams()
  const fileId   = params.get('id')
  const videoRef = useRef<HTMLVideoElement>(null)
  const [title, setTitle]     = useState('Loading…')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(true)

  // Google Drive direct streaming URL for publicly shared files
  const videoSrc = fileId
    ? `https://drive.google.com/uc?export=download&id=${fileId}`
    : ''

  useEffect(() => {
    if (!fileId) { setError('No recording ID in URL.'); setLoading(false); return }
    trackView(fileId)
    fetchDriveMeta(fileId)
      .then(meta => {
        if (meta?.name) setTitle(meta.name.replace(/\.webm$/i, ''))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [fileId])

  if (error) return (
    <div className="min-h-screen flex items-center justify-center text-gray-500">
      <div className="text-center gap-3 flex flex-col">
        <span className="text-4xl">🎬</span>
        <p className="font-medium">{error}</p>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4">
        <a href="/" className="text-brand-400 font-bold text-lg tracking-tight">Copycat</a>
        {!loading && (
          <h1 className="text-white font-semibold text-sm truncate max-w-md">{title}</h1>
        )}
        <a
          href="/dashboard"
          className="text-xs text-gray-400 hover:text-white transition-colors font-medium"
        >
          My recordings →
        </a>
      </div>

      {/* Video player */}
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        {loading ? (
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        ) : (
          <div className="w-full max-w-4xl flex flex-col gap-4">
            <video
              ref={videoRef}
              src={videoSrc}
              controls
              autoPlay={false}
              className="w-full rounded-2xl bg-black shadow-2xl"
              style={{ maxHeight: '70vh' }}
              onError={() => setError('Could not load video. Make sure the Drive file is set to "Anyone with the link can view".')}
            />
            {/* Download link */}
            <div className="flex items-center justify-end gap-3">
              <a
                href={`https://drive.google.com/file/d/${fileId}/view`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                Open in Google Drive ↗
              </a>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-center py-4 text-xs text-gray-600">
        Shared via <a href="/" className="text-brand-400 hover:underline">Copycat</a>
      </div>
    </div>
  )
}

export default function ViewPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <VideoViewer />
    </Suspense>
  )
}
