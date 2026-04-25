'use client'

import { useEffect, useState } from 'react'
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

function VideoViewer() {
  const params  = useSearchParams()
  const fileId  = params.get('id')
  const [title, setTitle]   = useState('')
  const [loading, setLoading] = useState(true)

  // Google Drive embed/preview URL — works for publicly shared files without
  // the redirect-to-virus-scan issue that hits the uc?export=download URL.
  const embedSrc = fileId
    ? `https://drive.google.com/file/d/${fileId}/preview`
    : ''

  useEffect(() => {
    if (!fileId) { setLoading(false); return }
    trackView(fileId)
    // Try to get the filename via the public Drive embed page title
    // (no API key needed — we just parse the og:title from the preview page,
    // but that's server-side only; so we leave the title as empty and let the
    // iframe show the native Drive player UI which includes the filename).
    setLoading(false)
  }, [fileId])

  if (!fileId) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">
      <div className="text-center flex flex-col gap-3">
        <span className="text-4xl">🎬</span>
        <p className="font-medium">No recording ID in URL.</p>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4 flex-shrink-0">
        <a href="/" className="text-brand-400 font-bold text-lg tracking-tight">Copycat</a>
        <a
          href="/dashboard"
          className="text-xs text-gray-400 hover:text-white transition-colors font-medium"
        >
          My recordings →
        </a>
      </div>

      {/* Video player — Google Drive iframe embed */}
      <div className="flex-1 flex items-center justify-center px-4 py-6">
        {loading ? (
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        ) : (
          <div className="w-full max-w-4xl flex flex-col gap-4">
            {/* Drive propagation patience banner */}
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <span className="text-base leading-none mt-0.5">⏳</span>
              <p className="leading-relaxed">
                Drive needs ~5&nbsp;min to make new files publicly streamable. Share link works after that. Need it now? Ask the sender to download and send the file directly.
              </p>
            </div>

            <div className="relative w-full rounded-2xl overflow-hidden shadow-2xl bg-black"
                 style={{ paddingTop: '56.25%' /* 16:9 */ }}>
              <iframe
                src={embedSrc}
                className="absolute inset-0 w-full h-full border-0"
                allow="autoplay"
                allowFullScreen
              />
            </div>
            {/* Open in Drive link */}
            <div className="flex items-center justify-end">
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
      <div className="text-center py-4 text-xs text-gray-600 flex-shrink-0">
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
