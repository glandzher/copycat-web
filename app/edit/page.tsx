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
  { id: 'Xenova/whisper-base',  label: 'Base',  size: '140 MB', blurb: 'Solid all-rounder for narration' },
  { id: 'Xenova/whisper-small', label: 'Small', size: '250 MB', blurb: 'Best quality, slower (use WebGPU if you have it)' },
]

// ── Drive helpers ─────────────────────────────────────────────────────────────

async function fetchDriveFile(fileId: string, token: string): Promise<{ name: string, blob: Blob }> {
  const meta = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json())
  if (meta.error) throw new Error(meta.error.message || 'Drive metadata fetch failed')

  const dl = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
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
  const meta: any = {
    name: videoName.replace(/\.webm$/i, '') + '.copycat.json',
    mimeType: 'application/json',
    appProperties: { copycatVideoId: videoFileId },
  }
  const body = JSON.stringify(sidecar, null, 2)
  const boundary = 'cc_' + Date.now()
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(meta) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + body +
    `\r\n--${boundary}--`

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`
  const res = await fetch(url, {
    method:  existingId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary="${boundary}"`,
    },
    body: multipart,
  })
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

  // 1. Auth + Drive download + sidecar load
  useEffect(() => {
    (async () => {
      if (!fileId) { setStage('error'); setError('No video id in URL'); return }
      const { data: { session: s } } = await supabase.auth.getSession()
      if (!s) { setStage('auth'); return }
      setSession(s)
      const token = s.provider_token
      if (!token) { setStage('error'); setError('No Drive token. Sign out and back in.'); return }

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
        setStage('error'); setError(e?.message || String(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  // 2. Run transcription
  async function runTranscription() {
    if (!videoBlob) return
    setStage('transcribing')
    setProgress({ pct: 5, msg: 'Decoding audio…' })
    try {
      const audio = await decodeTo16kMono(videoBlob)
      setProgress({ pct: 15, msg: 'Loading speech model (cached after first run)…' })

      // Dynamic URL import via `new Function` so TypeScript & webpack don't try
      // to statically resolve the remote module at build time.
      const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>
      // esm.sh auto-rewrites bare Node imports (fs, path…) to browser-safe
      // shims so the Whisper bundle loads without a "Failed to resolve module
      // specifier 'fs'" error that hits with raw jsdelivr .mjs.
      const tr = await dynamicImport('https://esm.sh/@huggingface/transformers@3.0.2')
      tr.env.allowLocalModels = false
      tr.env.useBrowserCache  = true
      tr.env.backends.onnx.wasm.numThreads = 1

      const pipe = await tr.pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        dtype:  'q8',
        progress_callback: (p: any) => {
          if (p.status === 'progress' && p.progress != null) {
            setProgress({
              pct: 15 + Math.min(50, p.progress / 2),
              msg: `Loading ${p.file || 'model'}… ${Math.round(p.progress)}%`,
            })
          }
        },
      })

      setProgress({ pct: 70, msg: 'Transcribing…' })
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

      // Clean: clamp + dedupe
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
      setTranscript(clean)
      setSteps(chunksToSteps(clean))
      setStage('editor')
      setProgress({ pct: 100, msg: 'Done' })
    } catch (e: any) {
      console.error(e)
      setStage('error')
      setError(e?.message || 'Transcription failed')
    }
  }

  // 3. Save sidecar
  async function save() {
    if (!session?.provider_token || !fileId || !videoName) return
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
      <a href="/dashboard" className="mt-4 text-brand-400 underline">Back to dashboard</a>
    </Center>
  )

  if (stage === 'loading' || stage === 'transcribing') return (
    <Center>
      <div className="w-full max-w-md flex flex-col gap-3">
        <p className="text-gray-300 text-center">{progress.msg}</p>
        <div className="w-full h-2 rounded-full bg-gray-800 overflow-hidden">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${progress.pct}%` }} />
        </div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
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
              />
            ))}
          </div>
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
  idx, step, videoUrl, onChange, onDelete, onSetStart, onSetEnd, onMoveUp, onMoveDown, onSeekMaster,
}: {
  idx: number; step: Step; videoUrl: string
  onChange: (p: Partial<Step>) => void
  onDelete: () => void
  onSetStart: () => void; onSetEnd: () => void
  onMoveUp?: () => void; onMoveDown?: () => void
  onSeekMaster: (t: number) => void
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
      {/* Mini player with caption overlay */}
      <div className="relative bg-black aspect-video group cursor-pointer" onClick={play}>
        <video
          ref={vidRef}
          src={videoUrl}
          muted playsInline preload="metadata"
          onTimeUpdate={onTU}
          className="w-full h-full object-contain"
        />
        {/* Step number badge */}
        <span className="absolute top-2 left-2 text-[11px] font-bold bg-purple-500 text-white px-2 py-0.5 rounded-full shadow">
          Step {idx + 1}
        </span>
        {/* Duration badge */}
        <span className="absolute top-2 right-2 text-[11px] tabular-nums bg-black/70 text-white px-2 py-0.5 rounded">
          {fmtTime(step.start)} – {fmtTime(step.end)} · {(step.end - step.start).toFixed(1)}s
        </span>
        {/* Play indicator on hover */}
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="bg-white/90 text-black rounded-full w-12 h-12 flex items-center justify-center text-xl font-bold">▶</span>
        </span>
        {/* Transcript caption overlay (Scribe-style) */}
        {(step.transcript || step.label) && (
          <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/90 to-transparent text-xs leading-snug text-white">
            <div className="line-clamp-3">{step.transcript || step.label}</div>
          </div>
        )}
      </div>

      {/* Editable label + controls */}
      <div className="p-3 flex flex-col gap-2">
        <div className="flex items-center gap-1">
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
          <button onClick={onMoveUp}   disabled={!onMoveUp}   title="Move up"   className="text-gray-500 hover:text-gray-200 disabled:opacity-30 px-1">▲</button>
          <button onClick={onMoveDown} disabled={!onMoveDown} title="Move down" className="text-gray-500 hover:text-gray-200 disabled:opacity-30 px-1">▼</button>
          <button onClick={onDelete}   title="Delete"         className="text-red-400 hover:text-red-300 px-1">✕</button>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-400">
          <span>Start</span>
          <input type="number" min={0} step={0.1} value={step.start.toFixed(2)}
            onChange={e => onChange({ start: Number(e.target.value) })}
            className="w-16 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5" />
          <button onClick={onSetStart} title="Set to master playhead" className="px-1.5 py-0.5 border border-gray-700 rounded hover:bg-gray-800">⏱</button>
          <span>End</span>
          <input type="number" min={0} step={0.1} value={step.end.toFixed(2)}
            onChange={e => onChange({ end: Number(e.target.value) })}
            className="w-16 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5" />
          <button onClick={onSetEnd} title="Set to master playhead" className="px-1.5 py-0.5 border border-gray-700 rounded hover:bg-gray-800">⏱</button>
          <button onClick={() => onSeekMaster(step.start)} title="Jump master player here"
            className="ml-auto px-2 py-0.5 border border-gray-700 rounded hover:bg-gray-800">↥ master</button>
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
