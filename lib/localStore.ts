// Tiny IndexedDB wrapper to remember a FileSystemDirectoryHandle across visits.
// All ops are best-effort; failures fall back to "no remembered handle".

const DB_NAME = 'copycat-local'
const STORE   = 'handles'
const VERSION = 1

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess       = () => resolve(r.result)
    r.onerror         = () => reject(r.error)
  })
}

async function put(key: string, value: any): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
  db.close()
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await open()
  const v = await new Promise<T | undefined>((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
  db.close()
  return v
}

export async function rememberDirHandle(label: string, handle: FileSystemDirectoryHandle) {
  try { await put('dir:' + label, handle) } catch (_) {}
}

export async function recallDirHandle(label: string): Promise<FileSystemDirectoryHandle | undefined> {
  try { return await get<FileSystemDirectoryHandle>('dir:' + label) } catch { return undefined }
}

export async function listFolderLabels(): Promise<string[]> {
  try {
    const db = await open()
    const labels = await new Promise<string[]>((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAllKeys()
      req.onsuccess = () => resolve((req.result as IDBValidKey[])
        .map(k => String(k))
        .filter(k => k.startsWith('dir:'))
        .map(k => k.slice(4)))
      req.onerror   = () => reject(req.error)
    })
    db.close()
    return labels
  } catch { return [] }
}

export async function forgetDirHandle(label: string) {
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete('dir:' + label)
      tx.oncomplete = () => resolve()
      tx.onerror    = () => reject(tx.error)
    })
    db.close()
  } catch (_) {}
}

// Re-acquire read/write permission on a stored handle. Browser auto-prompts.
export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<boolean> {
  try {
    // queryPermission/requestPermission live on the handle in Chromium.
    const opts = { mode } as any
    // @ts-ignore — these are Chromium-only methods
    const status = await handle.queryPermission(opts)
    if (status === 'granted') return true
    // @ts-ignore
    const next = await handle.requestPermission(opts)
    return next === 'granted'
  } catch { return false }
}

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}
