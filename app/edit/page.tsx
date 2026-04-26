'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { Session } from '@supabase/supabase-js'

// ── Types ─────────────────────────────────────────────────────────────────────

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

const MODELS = [
  { id: 'Xenova/whisper-base',                 label: 'Base',          size: '140 MB', blurb: 'Quick start, good for clear narration' },
  { id: 'Xenova/whisper-small',                label: 'Small',         size: '250 MB', blurb: 'Better names + technical terms' },
  { id: 'Xenova/whisper-medium',               label: 'Medium',        size: '760 MB', blurb: 'High accuracy, slow on CPU (~10× audio length)' },
  { id: 'distil-whisper/distil-large-v3',      label: 'Distil Large',  size: '750 MB', blurb: 'Same size as Medium, faster, near top-tier accuracy' },
]

// ── Drive helpers ─────────────────────────────────────────────────────────────

async function fetchDriveFile(fileId: string, token: string): Promise<{ name: string, blob: Blob }> {
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (metaRes.status === 401) throw new Error('AUTH_EXPIRED')
  const meta = await metaRes.json()
  if (meta.error) throw new Error(meta.error.message || 'Drive metadata fetch failed')

  const dl = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (dl.status === 401) throw new Error('AUTH_EXPIRED')
  if (!dl.ok) throw new Error(`Drive download failed (${dl.status})`)
  const blob = await dl.blob()
  return { name: meta.name, blob: new Blob([blob], { type: meta.mimeType || 'video/webm' }) }
}

async function findSidecar(videoFileId: string, token: string): Promise<{ id: string, data: Sidecar } | null> {
  const q = encodeURIComponent(
    `appProperties has { key='copycatVideoId' and value='${videoFileId}' } and trashed=false`
  )
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,appProperties)`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json())
  const f = res.files?.[0]
  if (!f) return null
  const dl = await fetch(
    `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!dl.ok) return null
  return { id: f.id, data: await dl.json() }
}

async function saveSidecar(
  videoFileId: string, videoName: string, sidecar: Sidecar, token: string, existingId: string | null
): Promise<string> {
  // Drive PATCH on /upload doesn't accept the same metadata (notably name +
  // appProperties) at the same time as content cleanly, so we split into two
  // calls when updating: PATCH metadata via /drive/v3, then PATCH content via
  // /upload/drive/v3 with uploadType=media.
  const baseName = videoName.replace(/\.webm$/i, '') + '.copycat.json'
  const body     = JSON.stringify(sidecar, null, 2)

  if (existingId) {
    // 1. Update metadata (name + appProperties)
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${existingId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: baseName, appProperties: { copycatVideoId: videoFileId } }),
    })
    if (metaRes.status === 401) throw new Error('AUTH_EXPIRED')
    if (!metaRes.ok) {
      const err = await metaRes.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Sidecar metadata update failed (${metaRes.status})`)
    }
    // 2. Replace content
    const contentRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    })
    if (contentRes.status === 401) throw new Error('AUTH_EXPIRED')
    if (!contentRes.ok) {
      const err = await contentRes.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Sidecar content update failed (${contentRes.status})`)
    }
    return existingId
  }

  // Create — multipart with metadata + content in one call
  const meta = {
    name: baseName,
    mimeType: 'application/json',
    appProperties: { copycatVideoId: videoFileId },
  }
  const boundary = 'cc_' + Date.now()
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(meta) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + body +
    `\r\n--${boundary}--`

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary="${boundary}"`,
    },
    body: multipart,
  })
  if (res.status === 401) throw new Error('AUTH_EXPIRED')
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Sidecar save failed (${res.status})`)
  }
  const out = await res.json()
  return out.id
}

// ── Audio decode (16 kHz mono Float32) ────────────────────────────────────────

async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer()
  const tmp = new AudioContext()
  const decoded = await tmp.decodeAudioData(buf.slice(0))
  await tmp.close().catch(() => {})
  const off = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.ceil(decoded.duration * 16000),
    sampleRate: 16000,
  })
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

// ── Step detection from transcript ────────────────────────────────────────────
// Boundary triggers: explicit "step N", number words, ordinals, sequencers.
// The boundary phrase must appear near the START of the chunk to count as a
// new step (avoids false positives mid-sentence like "...go to the next page").
const ORDINALS  = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth'
const NUMBERS   = 'one|two|three|four|five|six|seven|eight|nine|ten|\\d+'
const SEQUENCER = 'next|then|after that|now|finally|lastly|moving on'
const STEP_RE   = new RegExp(
  `^\\s*(?:(?:step|étape|paso|schritt)\\s+(?:${NUMBERS})\\b|(?:${ORDINALS})[\\s,]|(?:${SEQUENCER})[\\s,])`,
  'i'
)
// Also fire if a chunk STARTS with a digit + dot/colon ("1. open the…")
const NUMBERED_LINE = /^\s*\d+\s*[.:)]\s+/

function chunksToSteps(chunks: Chunk[]): Step[] {
  if (chunks.length === 0) return []
  const isBoundary = (text: string) => STEP_RE.test(text) || NUMBERED_LINE.test(text)
  const steps: Step[] = []
  let cur: Step | null = null
  for (const c of chunks) {
    if (cur === null || isBoundary(c.text)) {
      if (cur) steps.push(cur)
      cur = { start: c.start, end: c.end, label: c.text.slice(0, 60), transcript: c.text }
    } else {
      cur.end        = c.end
      cur.transcript = (cur.transcript + ' ' + c.text).trim()
      if (cur.label.length < 40) cur.label = (cur.label + ' ' + c.text).slice(0, 60)
    }
  }
  if (cur) steps.push(cur)
  return steps.map((s, i) =>
    /^step\b/i.test(s.label) ? s : { ...s, label: `Step ${i + 1}: ${s.label}` }
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

function EditorInner() {
  const params  = useSearchParams()
  const fileId  = params.get('id')

  const [session,  setSession]  = useState<Session | null>(null)
  const [stage,    setStage]    = useState<'auth' | 'loading' | 'pre' | 'transcribing' | 'editor' | 'error'>('loading')
  const [error,    setError]    = useState<string>('')
  const [progress, setProgress] = useState<{ pct: number; msg: string }>({ pct: 0, msg: '' })

  const [videoUrl,    setVideoUrl]    = useState<string>('')
  const [videoName,   setVideoName]   = useState<string>('')
  const [videoBlob,   setVideoBlob]   = useState<Blob | null>(null)
  const [model,       setModel]       = useState<string>('Xenova/whisper-base')
  const [transcript,  setTranscript]  = useState<Chunk[]>([])
  const [steps,       setSteps]       = useState<Step[]>([])
  const [sidecarId,   setSidecarId]   = useState<string | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [savedAt,     setSavedAt]     = useState<string>('')

  const playerRef = useRef<HTMLVideoElement>(null)
  const stopAtRef = useRef<number | null>(null)
  // Cache the loaded Whisper pipeline + decoded audio so per-step re-runs are cheap.
  const whisperRef = useRef<{ model: string, pipe: any } | null>(null)
  const audioRef   = useRef<Float32Array | null>(null)
  const [retranscribingIdx, setRetranscribingIdx] = useState<number | null>(null)
  const [retranscribedFlash, setRetranscribedFlash] = useState<number | null>(null)

  // Warn before closing during transcription / re-run / save
  useEffect(() => {
    const busy = stage === 'transcribing' || retranscribingIdx !== null || saving
    if (!busy) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [stage, retranscribingIdx, saving])

  // 1. Auth + Drive download + sidecar load
  useEffect(() => {
    (async () => {
      if (!fileId) { setStage('error'); setError('No video id in URL'); return }
      const { data: { session: s } } = await supabase.auth.getSession()
      if (!s) { setStage('auth'); return }
      setSession(s)

      // Google access tokens expire after ~1 hour. Re-run OAuth to refresh.
      // ONE attempt only — sessionStorage guards against infinite redirect loops
      // (which happen when Google can't issue a token silently and bounces back
      // without one).
      let token = s.provider_token
      if (!token) {
        const FLAG = 'cc_drive_refresh_attempted'
        if (sessionStorage.getItem(FLAG)) {
          sessionStorage.removeItem(FLAG)
          setStage('error')
          setError('Google Drive access expired. Click "Reconnect Drive" below.')
          return
        }
        sessionStorage.setItem(FLAG, '1')
        setProgress({ pct: 5, msg: 'Refreshing Google Drive access…' })
        await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.href,
            scopes: 'email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
            queryParams: { access_type: 'offline' },
          },
        })
        return
      }
      // Got a token — clear any leftover flag from a prior attempt
      sessionStorage.removeItem('cc_drive_refresh_attempted')

      try {
        setProgress({ pct: 10, msg: 'Fetching video metadata…' })
        const { name, blob } = await fetchDriveFile(fileId, token)
        setVideoName(name)
        setVideoBlob(blob)
        setVideoUrl(URL.createObjectURL(blob))

        setProgress({ pct: 70, msg: 'Looking for existing sidecar…' })
        const sc = await findSidecar(fileId, token)
        if (sc) {
          setSidecarId(sc.id)
          setTranscript(sc.data.transcript || [])
          setSteps(sc.data.chapters || [])
          setStage('editor')
        } else {
          setStage('pre')
        }
      } catch (e: any) {
        if (e?.message === 'AUTH_EXPIRED') {
          const FLAG = 'cc_drive_refresh_attempted'
          if (sessionStorage.getItem(FLAG)) {
            sessionStorage.removeItem(FLAG)
            setStage('error'); setError('Google Drive access expired. Click "Reconnect Drive" below.')
            return
          }
          sessionStorage.setItem(FLAG, '1')
          setProgress({ pct: 5, msg: 'Refreshing Google Drive access…' })
          await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo: window.location.href,
              scopes: 'email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
              queryParams: { access_type: 'offline' },
            },
          })
          return
        }
        setStage('error'); setError(e?.message || String(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  // 2. Run transcription
  // Loads Whisper pipeline (or returns cached one if same model).
  async function ensureWhisper(modelId: string, onProgress: (pct: number, msg: string) => void) {
    if (whisperRef.current?.model === modelId) return whisperRef.current.pipe
    onProgress(15, 'Loading speech model (cached after first run)…')
    const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>
    const tr = await dynamicImport('https://esm.sh/@huggingface/transformers@3.0.2')
    tr.env.allowLocalModels = false
    tr.env.useBrowserCache  = true
    tr.env.backends.onnx.wasm.numThreads = 1
    const pipe = await tr.pipeline('automatic-speech-recognition', modelId, {
      device: 'wasm', dtype: 'q8',
      progress_callback: (p: any) => {
        if (p.status === 'progress' && p.progress != null) {
          onProgress(15 + Math.min(50, p.progress / 2), `Loading ${p.file || 'model'}… ${Math.round(p.progress)}%`)
        }
      },
    })
    whisperRef.current = { model: modelId, pipe }
    return pipe
  }

  // Whisper inference helper — same generation knobs every call.
  async function runWhisper(pipe: any, audio: Float32Array): Promise<Chunk[]> {
    const dur = audio.length / 16000
    const out = await pipe(audio, {
      chunk_length_s:             30,
      stride_length_s:            5,
      return_timestamps:          true,
      language:                   'en',
      task:                       'transcribe',
      no_repeat_ngram_size:       3,
      repetition_penalty:         1.2,
      condition_on_previous_text: false,
    })
    const raw: Chunk[] = (out.chunks || []).map((c: any) => ({
      start: c.timestamp?.[0] ?? 0,
      end:   Math.min(c.timestamp?.[1] ?? dur, dur),
      text:  (c.text || '').trim(),
    })).filter((c: Chunk) => c.start <= dur)
    const clean: Chunk[] = []
    for (const c of raw) {
      const last = clean[clean.length - 1]
      if (last && last.text === c.text) { last.end = c.end; continue }
      clean.push(c)
    }
    return clean
  }

  async function runTranscription() {
    if (!videoBlob) return
    setStage('transcribing')
    setProgress({ pct: 5, msg: 'Decoding audio…' })
    try {
      const audio = await decodeTo16kMono(videoBlob)
      audioRef.current = audio
      const audioDur = audio.length / 16000
      const pipe = await ensureWhisper(model, (pct, msg) => setProgress({ pct, msg }))

      // While Whisper runs we have no granular progress hook, so we run a
      // wall-clock ticker. Whisper-base ≈ 0.5× realtime on a modern laptop
      // (i.e. 1 min of audio = ~30s of compute); medium/large can be 5–10×.
      // We use that ratio per model to estimate %.
      const ratio: Record<string, number> = {
        'Xenova/whisper-base':           0.5,
        'Xenova/whisper-small':          1.5,
        'Xenova/whisper-medium':         5,
        'distil-whisper/distil-large-v3': 3,
      }
      const expectedSec = audioDur * (ratio[model] || 2)
      const startedAt   = Date.now()
      let tick: any = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000
        const pct     = Math.min(95, 70 + (elapsed / expectedSec) * 25)
        setProgress({
          pct,
          msg: `Transcribing ${audioDur.toFixed(0)} s of audio · ${elapsed.toFixed(0)} s elapsed (est. ~${Math.max(0, expectedSec - elapsed).toFixed(0)} s left)`,
        })
      }, 1000)

      try {
        const chunks = await runWhisper(pipe, audio)
        setTranscript(chunks)
        setSteps(chunksToSteps(chunks))
        setStage('editor')
        setProgress({ pct: 100, msg: 'Done' })
      } finally { clearInterval(tick) }
    } catch (e: any) {
      console.error(e)
      setStage('error')
      setError(e?.message || 'Transcription failed')
    }
  }

  // Re-transcribe one step (slice audio) — short context often = much better text.
  async function retranscribeStep(idx: number) {
    const step = steps[idx]; if (!step) return
    setRetranscribingIdx(idx)
    try {
      if (!audioRef.current && videoBlob) {
        audioRef.current = await decodeTo16kMono(videoBlob)
      }
      if (!audioRef.current) throw new Error('Audio not available')
      const pipe = await ensureWhisper(model, () => {})

      const startSample = Math.max(0, Math.floor(step.start * 16000))
      const endSample   = Math.min(audioRef.current.length, Math.ceil(step.end * 16000))
      const slice       = audioRef.current.subarray(startSample, endSample)
      if (slice.length < 16000 * 0.4) {
        alert('Step is shorter than 0.4 s — Whisper needs a bit more audio.')
        return
      }
      const sliceChunks = await runWhisper(pipe, slice)
      const merged = sliceChunks.map(c => c.text).join(' ').trim()
      setSteps(prev => prev.map((s, j) =>
        j === idx ? { ...s, transcript: merged || s.transcript } : s
      ))
      setRetranscribedFlash(idx)
      setTimeout(() => setRetranscribedFlash(curr => curr === idx ? null : curr), 2500)
    } catch (e: any) {
      alert('Re-run failed: ' + (e?.message || e))
    } finally { setRetranscribingIdx(null) }
  }

  // 3. Save sidecar
  async function save() {
    if (!session?.provider_token || !fileId || !videoName) {
      alert('Not signed in. Refresh the page to sign back in.')
      return
    }
    setSaving(true)
    try {
      const sidecar: Sidecar = {
        version: 1, videoFileId: fileId,
        transcript, chapters: steps,
        model, updatedAt: new Date().toISOString(),
      }
      const newId = await saveSidecar(fileId, videoName, sidecar, session.provider_token, sidecarId)
      setSidecarId(newId)
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e: any) {
      if (e?.message === 'AUTH_EXPIRED') {
        // Silently refresh Google token then retry once user comes back
        await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.href,
            scopes: 'email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
            queryParams: { access_type: 'offline', prompt: 'none' },
          },
        })
        return
      }
      console.error('[edit] save failed:', e)
      alert('Save failed: ' + (e?.message || e))
    } finally { setSaving(false) }
  }

  // 4. Step play helper
  function playClip(start: number, end: number) {
    const p = playerRef.current; if (!p) return
    p.currentTime = start
    stopAtRef.current = end
    p.play().catch(() => {})
  }
  function onTimeUpdate() {
    const p = playerRef.current; if (!p) return
    if (stopAtRef.current != null && p.currentTime >= stopAtRef.current) {
      p.pause(); stopAtRef.current = null
    }
  }

  function setStepStartToNow(i: number) {
    const p = playerRef.current; if (!p) return
    setSteps(s => s.map((x, j) => j === i ? { ...x, start: +p.currentTime.toFixed(2) } : x))
  }
  function setStepEndToNow(i: number) {
    const p = playerRef.current; if (!p) return
    setSteps(s => s.map((x, j) => j === i ? { ...x, end: +p.currentTime.toFixed(2) } : x))
  }
  function addStepHere() {
    const p = playerRef.current; if (!p) return
    const t = p.currentTime; const dur = p.duration || (t + 5)
    setSteps(s => [...s, {
      start: +t.toFixed(2), end: +Math.min(t + 5, dur).toFixed(2),
      label: `Step ${s.length + 1}`, transcript: '',
    }])
  }

  function addStepAfterLast() {
    const p = playerRef.current; if (!p) return
    const dur = p.duration || 0
    const last = steps[steps.length - 1]
    const start = last ? last.end : 0
    if (start >= dur) return
    setSteps(s => [...s, {
      start, end: Math.min(start + 5, dur),
      label: `Step ${s.length + 1}`, transcript: '',
    }])
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (stage === 'auth') return (
    <Center>
      <p className="text-gray-300">You need to sign in first.</p>
      <a href="/login" className="mt-4 inline-block px-5 py-2 rounded-lg bg-brand-500 text-white font-semibold">Sign in</a>
    </Center>
  )

  if (stage === 'error') return (
    <Center>
      <p className="text-red-300 max-w-md text-center">⚠ {error}</p>
      <div className="flex gap-3 mt-4">
        <button
          onClick={async () => {
            sessionStorage.removeItem('cc_drive_refresh_attempted')
            await supabase.auth.signInWithOAuth({
              provider: 'google',
              options: {
                redirectTo: window.location.href,
                scopes: 'email profile https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
                queryParams: { access_type: 'offline' },
              },
            })
          }}
          className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold">
          Reconnect Drive
        </button>
        <a href="/dashboard" className="px-4 py-2 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800">
          Back to dashboard
        </a>
      </div>
    </Center>
  )

  if (stage === 'loading' || stage === 'transcribing') return (
    <Center>
      <div className="w-full max-w-md flex flex-col gap-3">
        <p className="text-gray-300 text-center">{progress.msg}</p>
        <div className="w-full h-2 rounded-full bg-gray-800 overflow-hidden">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
        {stage === 'transcribing' && (
          <p className="text-xs text-amber-300/80 text-center mt-3 leading-relaxed">
            ⚠️ Keep this tab open. You can switch to other tabs or apps — the work
            keeps progressing in the background. Closing this tab cancels it.
          </p>
        )}
      </div>
    </Center>
  )

  if (stage === 'pre') return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <TopBar fileId={fileId} />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl flex flex-col gap-5">
          <h1 className="text-2xl font-bold">Generate a Step Guide from your narration</h1>
          <p className="text-sm text-gray-400">
            Pick a model. Larger = more accurate but slower. The model downloads once to your browser, then
            stays cached. Audio never leaves your device — Whisper runs locally in your browser via WebAssembly.
          </p>
          <div className="grid gap-2">
            {MODELS.map(m => (
              <label key={m.id}
                className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors
                  ${model === m.id ? 'border-brand-500 bg-brand-500/10' : 'border-gray-800 hover:border-gray-700'}`}>
                <input type="radio" name="model" value={m.id} checked={model === m.id}
                  onChange={() => setModel(m.id)} className="m-0" />
                <div className="flex-1">
                  <div className="font-semibold">{m.label} <span className="text-xs text-gray-500 ml-1">· {m.size}</span></div>
                  <div className="text-xs text-gray-400">{m.blurb}</div>
                </div>
              </label>
            ))}
          </div>
          <button onClick={runTranscription}
            className="w-full py-3 rounded-xl bg-brand-500 hover:bg-brand-600 font-semibold">
            Start transcription →
          </button>
        </div>
      </main>
    </div>
  )

  // EDITOR stage
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <TopBar fileId={fileId} />
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 flex flex-col gap-5">
        {/* Master video + meta + actions */}
        <section className="flex flex-col gap-3">
          <video
            ref={playerRef}
            src={videoUrl}
            controls playsInline
            onTimeUpdate={onTimeUpdate}
            onPlay={(e) => {
              // Stop any step mini-player so audio doesn't overlap
              document.querySelectorAll('video').forEach(v => { if (v !== e.currentTarget) v.pause() })
            }}
            className="w-full rounded-xl bg-black aspect-video max-h-[55vh]"
          />
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span className="truncate">{videoName}</span>
            <span>· {steps.length} step{steps.length === 1 ? '' : 's'}</span>
            {savedAt && <span className="text-emerald-400">✓ saved at {savedAt}</span>}
            <div className="ml-auto flex gap-2">
              <button onClick={addStepHere}
                className="px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/40 text-purple-300 text-xs font-semibold hover:bg-purple-500/20">
                + Step at playhead
              </button>
              <button onClick={addStepAfterLast} disabled={!steps.length}
                className="px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/40 text-purple-300 text-xs font-semibold hover:bg-purple-500/20 disabled:opacity-40">
                + Step after last
              </button>
              <button onClick={save} disabled={saving}
                className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold disabled:opacity-50">
                {saving ? 'Saving…' : '💾 Save'}
              </button>
            </div>
          </div>
        </section>

        {/* Step grid */}
        {steps.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-8 border border-dashed border-gray-800 rounded-xl">
            No steps yet. Add one above.
          </div>
        ) : (
          <>
          <div className="flex flex-col gap-4 max-w-3xl w-full mx-auto">
            {steps.map((s, i) => (
              <StepCard
                key={i} idx={i} step={s} videoUrl={videoUrl}
                onChange={(patch) => setSteps(prev => prev.map((x, j) => j === i ? { ...x, ...patch } : x))}
                onDelete={() => setSteps(prev => prev.filter((_, j) => j !== i))}
                onSetStart={() => setStepStartToNow(i)}
                onSetEnd={() => setStepEndToNow(i)}
                onMoveUp={i > 0   ? () => setSteps(p => swap(p, i, i - 1)) : undefined}
                onMoveDown={i < steps.length - 1 ? () => setSteps(p => swap(p, i, i + 1)) : undefined}
                onSeekMaster={(t) => { const p = playerRef.current; if (p) { p.currentTime = t; p.pause(); } }}
                onRetranscribe={() => retranscribeStep(i)}
                isRetranscribing={retranscribingIdx === i}
                justRetranscribed={retranscribedFlash === i}
              />
            ))}
          </div>
          {/* Bottom-of-list add buttons so you don't scroll back to the top */}
          <div className="max-w-3xl w-full mx-auto flex gap-2 mt-2">
            <button onClick={addStepHere}
              className="flex-1 py-2 rounded-lg bg-purple-500/10 border border-purple-500/40 text-purple-300 text-sm font-semibold hover:bg-purple-500/20">
              + Step at playhead
            </button>
            <button onClick={addStepAfterLast}
              className="flex-1 py-2 rounded-lg bg-purple-500/10 border border-purple-500/40 text-purple-300 text-sm font-semibold hover:bg-purple-500/20">
              + Step after last
            </button>
          </div>
          </>
        )}

        {/* Raw transcript drawer */}
        <details className="rounded-lg bg-gray-900/50 p-3 text-xs">
          <summary className="cursor-pointer text-gray-400">Raw transcript ({transcript.length} chunks)</summary>
          <div className="mt-2 max-h-64 overflow-y-auto leading-relaxed">
            {transcript.map((c, i) => (
              <div key={i} className="mb-1">
                <span className="text-gray-500 tabular-nums mr-2">{fmtTime(c.start)}–{fmtTime(c.end)}</span>
                {c.text}
              </div>
            ))}
          </div>
        </details>
      </main>
    </div>
  )
}

function swap<T>(arr: T[], a: number, b: number): T[] {
  const c = [...arr]; const t = c[a]; c[a] = c[b]; c[b] = t; return c
}

function fmtTime(s: number) {
  if (s == null || isNaN(s)) return '--:--'
  const m = Math.floor(s / 60), ss = Math.floor(s % 60), ms = Math.floor((s % 1) * 10)
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${ms}`
}

function StepCard({
  idx, step, videoUrl, onChange, onDelete, onSetStart, onSetEnd,
  onMoveUp, onMoveDown, onSeekMaster, onRetranscribe, isRetranscribing, justRetranscribed,
}: {
  idx: number; step: Step; videoUrl: string
  onChange: (p: Partial<Step>) => void
  onDelete: () => void
  onSetStart: () => void; onSetEnd: () => void
  onMoveUp?: () => void; onMoveDown?: () => void
  onSeekMaster: (t: number) => void
  onRetranscribe: () => void
  isRetranscribing: boolean
  justRetranscribed: boolean
}) {
  const vidRef = useRef<HTMLVideoElement>(null)
  const stopAt = useRef<number | null>(null)
  const [editLabel, setEditLabel] = useState(false)

  // Snap to step.start on mount + whenever start changes (so the poster shows the step's first frame)
  useEffect(() => {
    const v = vidRef.current; if (!v) return
    v.currentTime = step.start
  }, [step.start, videoUrl])

  function play() {
    const v = vidRef.current; if (!v) return
    // Pause every other <video> on the page so players don't overlap audio
    document.querySelectorAll('video').forEach(other => { if (other !== v) other.pause() })
    v.currentTime = step.start
    stopAt.current = step.end
    v.play().catch(() => {})
  }
  function onTU(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget
    if (stopAt.current != null && v.currentTime >= stopAt.current) {
      v.pause(); v.currentTime = step.start; stopAt.current = null
    }
  }

  return (
    <div className="bg-gray-900/70 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
      {/* Header: step number + label + reorder/delete */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="text-[11px] font-bold bg-purple-500 text-white px-2 py-0.5 rounded-full">
          Step {idx + 1}
        </span>
        {editLabel ? (
          <input
            autoFocus
            value={step.label}
            onChange={e => onChange({ label: e.target.value })}
            onBlur={() => setEditLabel(false)}
            onKeyDown={e => { if (e.key === 'Enter') setEditLabel(false) }}
            className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-sm"
          />
        ) : (
          <button onClick={() => setEditLabel(true)}
            className="flex-1 text-left text-sm font-semibold truncate hover:text-brand-400">
            {step.label || <span className="italic text-gray-500">(click to label)</span>}
          </button>
        )}
        <span className="text-[11px] tabular-nums text-gray-400 mr-2">
          {fmtTime(step.start)}–{fmtTime(step.end)} · {(step.end - step.start).toFixed(1)}s
        </span>
        <button onClick={onMoveUp}   disabled={!onMoveUp}   title="Move up"   className="text-gray-500 hover:text-gray-200 disabled:opacity-30 px-1">▲</button>
        <button onClick={onMoveDown} disabled={!onMoveDown} title="Move down" className="text-gray-500 hover:text-gray-200 disabled:opacity-30 px-1">▼</button>
        <button onClick={onDelete}   title="Delete"         className="text-red-400 hover:text-red-300 px-1">✕</button>
      </div>

      {/* Mini player (sound on, click anywhere to play this clip) */}
      <div className="relative bg-black aspect-video mt-3 group cursor-pointer" onClick={play}>
        <video
          ref={vidRef}
          src={videoUrl}
          playsInline preload="metadata"
          onTimeUpdate={onTU}
          className="w-full h-full object-contain"
        />
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <span className="bg-white/90 text-black rounded-full w-12 h-12 flex items-center justify-center text-xl font-bold">▶</span>
        </span>
      </div>

      {/* Editable transcript for this step */}
      <div className="p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-gray-500 uppercase tracking-wide">Narration</label>
          <button
            onClick={onRetranscribe}
            disabled={isRetranscribing}
            title="Re-run the speech model on just this clip — short context often = better text"
            className={`text-[11px] disabled:opacity-50 ${
              justRetranscribed ? 'text-emerald-400' : 'text-brand-400 hover:text-brand-300'
            }`}>
            {isRetranscribing ? '↻ Re-running… (don\'t close the tab)' :
             justRetranscribed ? '✓ Re-run done — check below'   :
             '↻ Re-run on this clip'}
          </button>
        </div>
        <textarea
          value={step.transcript}
          onChange={e => onChange({ transcript: e.target.value })}
          rows={Math.min(6, Math.max(2, Math.ceil((step.transcript?.length || 0) / 70)))}
          placeholder="(no narration captured for this step)"
          className={`w-full bg-gray-950 border rounded-lg px-3 py-2 text-sm leading-relaxed text-gray-200 focus:outline-none focus:border-brand-500 resize-y transition-colors ${
            justRetranscribed ? 'border-emerald-500/60 ring-1 ring-emerald-500/40' : 'border-gray-800'
          }`}
        />

        {/* Time controls */}
        <div className="flex items-center gap-2 text-[11px] text-gray-400 mt-1">
          <span>Start</span>
          <input type="number" min={0} step={0.1} value={step.start.toFixed(2)}
            onChange={e => onChange({ start: Number(e.target.value) })}
            className="w-20 bg-gray-950 border border-gray-700 rounded px-2 py-0.5" />
          <button onClick={onSetStart} title="Set to master playhead" className="px-2 py-0.5 border border-gray-700 rounded hover:bg-gray-800">⏱ now</button>
          <span>End</span>
          <input type="number" min={0} step={0.1} value={step.end.toFixed(2)}
            onChange={e => onChange({ end: Number(e.target.value) })}
            className="w-20 bg-gray-950 border border-gray-700 rounded px-2 py-0.5" />
          <button onClick={onSetEnd} title="Set to master playhead" className="px-2 py-0.5 border border-gray-700 rounded hover:bg-gray-800">⏱ now</button>
          <button onClick={() => onSeekMaster(step.start)} title="Jump master player here"
            className="ml-auto px-2 py-0.5 border border-gray-700 rounded hover:bg-gray-800">↥ master</button>
          <button onClick={play} className="px-3 py-0.5 bg-brand-500 hover:bg-brand-600 text-white rounded font-semibold">▶ Play</button>
        </div>
      </div>
    </div>
  )
}

function TopBar({ fileId }: { fileId: string | null }) {
  return (
    <div className="flex items-center justify-between px-6 py-3 border-b border-gray-900">
      <a href="/" className="text-brand-400 font-bold text-lg">Copycat</a>
      <div className="flex items-center gap-4 text-sm">
        {fileId && (
          <a href={`/view?id=${fileId}`} target="_blank"
             className="text-gray-400 hover:text-white">Open viewer ↗</a>
        )}
        <a href="/dashboard" className="text-gray-400 hover:text-white">Dashboard →</a>
      </div>
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-100 p-6">
      <div className="flex flex-col items-center gap-3">{children}</div>
    </div>
  )
}

export default function EditPage() {
  return (
    <Suspense fallback={<Center><div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" /></Center>}>
      <EditorInner />
    </Suspense>
  )
}
