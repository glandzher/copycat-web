'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

// ── Types (must match /edit sidecar shape) ────────────────────────────────────
type Chunk    = { start: number; end: number; text: string }
type Step     = { start: number; end: number; label: string; transcript: string }
type Sidecar  = {
  version: 1
  videoFileId: string
  transcript: Chunk[]
  chapters: Step[]
  model?: string
  updatedAt: string
}

async function trackView(fileId: string) {
  try {
    await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
  } catch (_) {}
}

function fmtTime(s: number) {
  if (s == null || isNaN(s)) return '--:--'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

// ── Drive (existing) viewer ──────────────────────────────────────────────────
function DriveViewer({ fileId }: { fileId: string }) {
  useEffect(() => { trackView(fileId) }, [fileId])
  const embedSrc = `https://drive.google.com/file/d/${fileId}/preview`
  return (
    <div className="w-full max-w-4xl flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        <span className="text-base leading-none mt-0.5">⏳</span>
        <p className="leading-relaxed">
          Drive needs ~5&nbsp;min to make new files publicly streamable. Share link works after that. Need it now? Click the &ldquo;Open in Google Drive&rdquo; button and then click download.
        </p>
      </div>
      <div className="relative w-full rounded-2xl overflow-hidden shadow-2xl bg-black" style={{ paddingTop: '56.25%' }}>
        <iframe src={embedSrc} className="absolute inset-0 w-full h-full border-0" allow="autoplay" allowFullScreen />
      </div>
      <div className="flex items-center justify-end">
        <a href={`https://drive.google.com/file/d/${fileId}/view`} target="_blank" rel="noopener noreferrer"
          className="text-xs text-gray-400 hover:text-white transition-colors">
          Open in Google Drive ↗
        </a>
      </div>
    </div>
  )
}

// ── Local-package viewer (loaded from a dropped .copycat.zip) ────────────────
function PackageViewer({ videoUrl, sidecar }: { videoUrl: string, sidecar: Sidecar }) {
  const playerRef = useRef<HTMLVideoElement>(null)
  const stopAtRef = useRef<number | null>(null)
  function playClip(start: number, end: number) {
    const p = playerRef.current; if (!p) return
    p.currentTime = start
    stopAtRef.current = end
    p.play().catch(() => {})
  }
  function onTU() {
    const p = playerRef.current; if (!p) return
    if (stopAtRef.current != null && p.currentTime >= stopAtRef.current) {
      p.pause(); stopAtRef.current = null
    }
  }
  return (
    <div className="w-full max-w-5xl flex flex-col gap-4">
      <video ref={playerRef} src={videoUrl} controls playsInline onTimeUpdate={onTU}
        className="w-full rounded-xl bg-black aspect-video max-h-[55vh]" />
      <div className="text-xs text-gray-500">
        📦 Loaded from package · {sidecar.chapters.length} step{sidecar.chapters.length === 1 ? '' : 's'}
      </div>
      <div className="flex flex-col gap-3 max-w-3xl w-full mx-auto">
        {sidecar.chapters.map((s, i) => (
          <div key={i} className="bg-gray-900/70 border border-gray-800 rounded-xl p-3 flex gap-3 items-start">
            <button onClick={() => playClip(s.start, s.end)}
              className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded font-semibold flex-shrink-0">
              ▶ Play
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold bg-purple-500 text-white px-2 py-0.5 rounded-full">Step {i + 1}</span>
                <span className="text-sm font-semibold truncate">{s.label}</span>
                <span className="text-[11px] tabular-nums text-gray-500 ml-auto">{fmtTime(s.start)}–{fmtTime(s.end)}</span>
              </div>
              {s.transcript && (
                <p className="text-sm text-gray-300 mt-1 leading-relaxed">{s.transcript}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Drop zone (when no Drive id and no package loaded yet) ───────────────────
function DropZone({ onLoaded }: { onLoaded: (videoUrl: string, sidecar: Sidecar) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState<string>('')
  async function handleZip(file: File) {
    setBusy(true); setErr('')
    try {
      const JSZip = (await import('jszip')).default
      const zip   = await JSZip.loadAsync(file)
      let videoFile: { name: string, blob: Blob } | null = null
      let sidecar:   Sidecar | null = null
      for (const name of Object.keys(zip.files)) {
        const entry = zip.files[name]
        if (entry.dir) continue
        if (/\.webm$/i.test(name)) {
          const b = await entry.async('blob')
          videoFile = { name, blob: new Blob([b], { type: 'video/webm' }) }
        } else if (/\.copycat\.json$/i.test(name)) {
          sidecar = JSON.parse(await entry.async('string'))
        }
      }
      if (!videoFile || !sidecar) throw new Error('Package missing .webm or .copycat.json')
      onLoaded(URL.createObjectURL(videoFile.blob), sidecar)
    } catch (e: any) {
      setErr(e?.message || 'Could not read package')
    } finally { setBusy(false) }
  }
  return (
    <div
      onDragOver={e => { e.preventDefault() }}
      onDrop={e => {
        e.preventDefault()
        const f = e.dataTransfer.files?.[0]
        if (f) handleZip(f)
      }}
      className="w-full max-w-2xl border-2 border-dashed border-gray-700 rounded-2xl p-12 text-center flex flex-col gap-4 hover:border-brand-500 transition-colors">
      <span className="text-5xl">📦</span>
      <h2 className="text-xl font-bold text-gray-100">Drop a Copycat package here</h2>
      <p className="text-sm text-gray-400">
        Got a <code className="bg-black/40 px-1 rounded">.copycat.zip</code> file from someone? Drop it here to view their step guide.
        Everything plays in your browser — nothing is uploaded.
      </p>
      <label className="inline-block">
        <input type="file" accept=".zip,.copycat.zip" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleZip(f) }} />
        <span className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold cursor-pointer inline-block">
          Or pick a file…
        </span>
      </label>
      {busy && <p className="text-sm text-gray-400">Reading package…</p>}
      {err  && <p className="text-sm text-red-400">⚠ {err}</p>}
    </div>
  )
}

// ── Page wrapper ─────────────────────────────────────────────────────────────
function ViewPageInner() {
  const params  = useSearchParams()
  const fileId  = params.get('id')
  const [pkg, setPkg] = useState<{ videoUrl: string, sidecar: Sidecar } | null>(null)

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 flex-shrink-0">
        <a href="/" className="text-brand-400 font-bold text-lg tracking-tight">Copycat</a>
        <a href="/dashboard" className="text-xs text-gray-400 hover:text-white transition-colors font-medium">
          My recordings →
        </a>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-6">
        {fileId ? <DriveViewer fileId={fileId} />
        : pkg     ? <PackageViewer videoUrl={pkg.videoUrl} sidecar={pkg.sidecar} />
        :           <DropZone onLoaded={(videoUrl, sidecar) => setPkg({ videoUrl, sidecar })} />}
      </div>

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
      <ViewPageInner />
    </Suspense>
  )
}
