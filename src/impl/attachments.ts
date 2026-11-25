/**
 * Attachment lookup: read the bytes behind an attachment id or a file path.
 *
 * The host context store is tried first (`imageHostPath` / `readImage` / `get`), then the plugin state dir layout, so a prompt image resolves the same on every host generation.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import { classifyLocalFileUrlHead } from './paths.ts'

export function normalizeFileUrlToPath(uri: string): string {
  if (!/^file:\/\//i.test(uri)) return uri
  // Decode BEFORE classifying: `file:///C:%2Fwork` is a drive head only once
  // the escaped separator is read as `/` (single decode — '%252F' stays '%2F').
  let afterScheme = uri.slice('file://'.length)
  try {
    afterScheme = decodeURIComponent(afterScheme)
  } catch { /* keep the raw spelling; the classifier handles it as-is */ }
  const head = classifyLocalFileUrlHead(afterScheme, { allowBareDrive: true })
  if (head.kind === 'drive') {
    return `${head.driveLetter}:${head.sep}${afterScheme.slice(head.consumed)}`
  }
  if (head.kind === 'posix') return `/${afterScheme.slice(head.consumed)}`
  if (head.kind === 'incomplete') {
    const path = afterScheme.startsWith('/') ? afterScheme : `/${afterScheme.replace(/^localhost\/?/i, '')}`
    // A completed URL will not grow: a bare drive root (`file:///C:`) is a
    // drive, while `file:///C` stays a POSIX path.
    const bareDrive = /^\/([A-Za-z]):$/.exec(path)
    return bareDrive === null ? path : `${bareDrive[1]}:`
  }
  return `//${afterScheme}`
}

function expandHomePath(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (typeof process !== 'undefined' && process.env) {
      const env = process.env
      const home = env.HOME || env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
      if (home) {
        const cleanHome = home.replaceAll('\\', '/').replace(/\/+$/, '')
        return p === '~' ? cleanHome : `${cleanHome}/${p.slice(2).replaceAll('\\', '/')}`
      }
    }
  }
  return p
}

/** Read one file's bytes: host `context.readFile` / `context.fs` first, then the builtin `fs` module via `process.getBuiltinModule` (never a static Node import). */
export function readImageFileFromContext(filePath: string, context?: unknown): Buffer | Uint8Array | string | undefined {
  const target = normalizeFileUrlToPath(filePath)
  const expanded = expandHomePath(target)
  const pathsToTry = target === expanded ? [target] : [target, expanded]

  const builtinFs = typeof process !== 'undefined' && typeof (process as unknown as { getBuiltinModule?: (m: string) => unknown }).getBuiltinModule === 'function'
    ? ((process as unknown as { getBuiltinModule: (m: string) => unknown }).getBuiltinModule('fs') as { existsSync?: (p: string) => boolean; readFileSync?: (p: string) => Buffer } | null)
    : null

  for (const p of pathsToTry) {
    if (context && typeof (context as { readFile?: unknown }).readFile === 'function') {
      try {
        const res = (context as { readFile: (path: string) => unknown }).readFile(p)
        if (res !== undefined) return res as Buffer | Uint8Array | string
      } catch {}
    }
    if (context && typeof (context as { fs?: { readFileSync?: unknown } }).fs?.readFileSync === 'function') {
      try {
        const res = (context as { fs: { readFileSync: (path: string) => unknown } }).fs.readFileSync(p)
        if (res !== undefined) return res as Buffer | Uint8Array | string
      } catch {}
    }
    if (builtinFs && typeof builtinFs.existsSync === 'function' && typeof builtinFs.readFileSync === 'function') {
      try {
        if (builtinFs.existsSync(p)) return builtinFs.readFileSync(p)
      } catch {}
    }
  }
  return undefined
}

function tryResolveFromAttachmentStore(
  store: Record<string, unknown>,
  id: string,
  context?: unknown,
  attachmentMeta?: unknown,
): unknown {
  const idWithoutPrefix = id.startsWith('sha256:') ? id.slice('sha256:'.length) : undefined
  const idWithPrefix = id.startsWith('sha256:') ? id : `sha256:${id}`

  const candidates: unknown[] = []
  if (attachmentMeta && typeof attachmentMeta === 'object') {
    candidates.push(attachmentMeta)
  }
  candidates.push({ attachmentId: idWithPrefix })
  if (idWithoutPrefix !== undefined) {
    candidates.push({ attachmentId: idWithoutPrefix })
  }
  candidates.push({ attachmentId: id })
  candidates.push({ id: idWithPrefix })
  candidates.push({ id })
  if (idWithoutPrefix !== undefined) {
    candidates.push({ id: idWithoutPrefix })
  }
  candidates.push(id)
  if (idWithoutPrefix !== undefined) {
    candidates.push(idWithoutPrefix)
  }

  // Cordis proxies wrap the underlying service instance; if a method call on the proxy fails
  // or loses this context, fall back to the unwrapped instance (never the class prototype,
  // which lacks instance state such as `this.root`).
  const cordisOriginal = Reflect.get(store, Symbol.for('cordis.original')) as Record<string, unknown> | undefined

  // A. LocalAttachmentStore.imageHostPath(ref) -> synchronous local absolute path
  if (typeof store.imageHostPath === 'function') {
    const fn = store.imageHostPath as (ref: unknown) => unknown
    for (const cand of candidates) {
      if (cand === undefined) continue
      try {
        let hostPath: unknown
        try {
          hostPath = fn.call(store, cand)
        } catch {
          if (cordisOriginal && typeof cordisOriginal.imageHostPath === 'function') {
            hostPath = (cordisOriginal.imageHostPath as (ref: unknown) => unknown).call(cordisOriginal, cand)
          }
        }
        if (hostPath && typeof (hostPath as Promise<unknown>).then === 'function') {
          if (typeof (hostPath as Promise<unknown>).catch === 'function') {
            (hostPath as Promise<unknown>).catch(() => {})
          }
        } else if (typeof hostPath === 'string' && hostPath.trim() !== '') {
          const fileContent = readImageFileFromContext(hostPath, context)
          return {
            path: hostPath,
            ...(fileContent !== undefined ? { data: fileContent } : {}),
          }
        }
      } catch {}
    }
  }

  // B. LocalAttachmentStore.fileHostPath(ref) -> fallback for file-type attachments
  if (typeof store.fileHostPath === 'function') {
    const fn = store.fileHostPath as (ref: unknown) => unknown
    for (const cand of candidates) {
      if (cand === undefined) continue
      try {
        let hostPath: unknown
        try {
          hostPath = fn.call(store, cand)
        } catch {
          if (cordisOriginal && typeof cordisOriginal.fileHostPath === 'function') {
            hostPath = (cordisOriginal.fileHostPath as (ref: unknown) => unknown).call(cordisOriginal, cand)
          }
        }
        if (hostPath && typeof (hostPath as Promise<unknown>).then === 'function') {
          if (typeof (hostPath as Promise<unknown>).catch === 'function') {
            (hostPath as Promise<unknown>).catch(() => {})
          }
        } else if (typeof hostPath === 'string' && hostPath.trim() !== '') {
          const fileContent = readImageFileFromContext(hostPath, context)
          return {
            path: hostPath,
            ...(fileContent !== undefined ? { data: fileContent } : {}),
          }
        }
      } catch {}
    }
  }

  // C. LocalAttachmentStore.readImage(ref) -> { ref, data: Uint8Array }
  if (typeof store.readImage === 'function') {
    const fn = store.readImage as (ref: unknown) => unknown
    for (const cand of candidates) {
      if (cand === undefined) continue
      try {
        let res: unknown
        try {
          res = fn.call(store, cand)
        } catch {
          if (cordisOriginal && typeof cordisOriginal.readImage === 'function') {
            res = (cordisOriginal.readImage as (ref: unknown) => unknown).call(cordisOriginal, cand)
          }
        }
        if (res && typeof res === 'object') {
          // If it's a Promise (async), safely attach catch to avoid unhandledRejection crashes
          if (typeof (res as Promise<unknown>).then === 'function') {
            if (typeof (res as Promise<unknown>).catch === 'function') {
              (res as Promise<unknown>).catch(() => {})
            }
          } else {
            if (res instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(res))) {
              return res
            }
            const data = (res as { data?: unknown }).data
            if (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) || typeof data === 'string') {
              return { data }
            }
          }
        }
      } catch {}
    }
  }

  // D. readAttachment
  if (typeof store.readAttachment === 'function') {
    try {
      let res: unknown
      try {
        res = (store.readAttachment as (id: string) => unknown).call(store, id)
      } catch {
        if (cordisOriginal && typeof cordisOriginal.readAttachment === 'function') {
          res = (cordisOriginal.readAttachment as (id: string) => unknown).call(cordisOriginal, id)
        }
      }
      if (res && typeof (res as Promise<unknown>).then === 'function') {
        if (typeof (res as Promise<unknown>).catch === 'function') {
          (res as Promise<unknown>).catch(() => {})
        }
      } else if (res !== undefined) {
        return res
      }
    } catch {}
  }

  // E. getAttachment
  if (typeof store.getAttachment === 'function') {
    try {
      let res: unknown
      try {
        res = (store.getAttachment as (id: string) => unknown).call(store, id)
      } catch {
        if (cordisOriginal && typeof cordisOriginal.getAttachment === 'function') {
          res = (cordisOriginal.getAttachment as (id: string) => unknown).call(cordisOriginal, id)
        }
      }
      if (res && typeof (res as Promise<unknown>).then === 'function') {
        if (typeof (res as Promise<unknown>).catch === 'function') {
          (res as Promise<unknown>).catch(() => {})
        }
      } else if (res !== undefined) {
        return res
      }
    } catch {}
  }

  return undefined
}

function tryStoreFreeDiskAttachment(id: string, context?: unknown): unknown {
  if (typeof id !== 'string') return undefined
  let hash: string | undefined
  const trimmed = id.trim()
  if (trimmed.startsWith('sha256:')) {
    hash = trimmed.slice('sha256:'.length).toLowerCase()
  } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    hash = trimmed.toLowerCase()
  }
  if (!hash || hash.length < 2) return undefined

  const prefix = hash.slice(0, 2)
  const relPaths = [
    `attachments/v1/objects/${prefix}/${hash}`,
    `attachments/v1/file-objects/${prefix}/${hash}`,
  ]

  const candidatePaths: string[] = []

  if (typeof process !== 'undefined' && process.env) {
    const env = process.env
    if (env.DSH_NTR_STATE_DIR) {
      const stateDir = env.DSH_NTR_STATE_DIR.replaceAll('\\', '/').replace(/\/+$/, '')
      const hostDir = stateDir.endsWith('/dsh-ntr') ? stateDir.slice(0, -'/dsh-ntr'.length) : stateDir
      for (const rel of relPaths) candidatePaths.push(`${hostDir}/${rel}`)
    }
    if (env.DSH_DIR) {
      const dshDir = env.DSH_DIR.replaceAll('\\', '/').replace(/\/+$/, '')
      for (const rel of relPaths) candidatePaths.push(`${dshDir}/${rel}`)
    }
    const home = env.HOME || env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
    if (home) {
      const cleanHome = home.replaceAll('\\', '/').replace(/\/+$/, '')
      for (const rel of relPaths) {
        candidatePaths.push(`${cleanHome}/.dsh/${rel}`)
        candidatePaths.push(`${cleanHome}\\.dsh\\${rel.replaceAll('/', '\\')}`)
      }
    }
  }
  for (const rel of relPaths) candidatePaths.push(`~/.dsh/${rel}`)

  for (const p of candidatePaths) {
    const fileContent = readImageFileFromContext(p, context)
    if (fileContent !== undefined) {
      return {
        path: p,
        data: fileContent,
      }
    }
  }

  return undefined
}

export function resolveImageAttachmentFromContext(
  id: string,
  context?: unknown,
  attachmentMeta?: unknown,
  rootContext?: unknown,
): unknown {
  const root = rootContext ?? context
  if (context && typeof context === 'object') {
    const ctx = context as Record<string, unknown>

    const direct = tryResolveFromAttachmentStore(ctx, id, root, attachmentMeta)
    if (direct !== undefined) return direct

    if (typeof ctx.get === 'function') {
      try {
        const svc = (ctx.get as (name: string) => unknown)('attachments') ?? (ctx.get as (name: string) => unknown)('attachmentService')
        if (svc && typeof svc === 'object') {
          const res = resolveImageAttachmentFromContext(id, svc, attachmentMeta, root)
          if (res !== undefined) return res
        }
      } catch {}
    }

    try {
      if (ctx.attachmentService && typeof ctx.attachmentService === 'object') {
        const res = resolveImageAttachmentFromContext(id, ctx.attachmentService, attachmentMeta, root)
        if (res !== undefined) return res
      }
    } catch {}

    try {
      const attStore = ctx.attachments
      if (attStore) {
        if (typeof attStore === 'object') {
          const fromStore = tryResolveFromAttachmentStore(attStore as Record<string, unknown>, id, root, attachmentMeta)
          if (fromStore !== undefined) return fromStore
        }
        if (attStore instanceof Map || typeof (attStore as { get?: unknown }).get === 'function') {
          try { return (attStore as Map<string, unknown>).get(id) } catch {}
        }
        if (typeof attStore === 'object' && Object.prototype.hasOwnProperty.call(attStore, id)) {
          return (attStore as Record<string, unknown>)[id]
        }
      }
    } catch {}
  }

  return tryStoreFreeDiskAttachment(id, root)
}
