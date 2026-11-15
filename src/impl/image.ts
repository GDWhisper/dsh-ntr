/**
 * Image payload resolution for a forwarded prompt: MIME guessing, magic numbers and block spellings.
 *
 * Guesses a MIME type from the extension, the magic number or the declared field, and reads bytes through `attachments.ts` before answering.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

import { isAbsolutePath } from './paths.ts'
import { readImageFileFromContext, resolveImageAttachmentFromContext } from './attachments.ts'

/**
 * Outcome of picking the one message an ACP turn forwards.
 *
 * `no-user-input` is its own case, not an error: the host wakes a driver for
 * injected context too (goal/subagent/skill material), and that turn carries no
 * user intent to send anywhere.
 */
export interface PromptImageContent {
  type: 'image'
  data: string
  mimeType: string
  uri?: string
}

export interface PromptTextContent {
  type: 'text'
  text: string
}

export type PromptContentBlock = PromptTextContent | PromptImageContent

/** Helper: guess MIME type from file extension or URL */
export function guessImageMimeType(pathOrUrl?: string): string | undefined {
  if (!pathOrUrl) return undefined
  const clean = pathOrUrl.split('?')[0].split('#')[0].toLowerCase()
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg'
  if (clean.endsWith('.png')) return 'image/png'
  if (clean.endsWith('.gif')) return 'image/gif'
  if (clean.endsWith('.webp')) return 'image/webp'
  if (clean.endsWith('.svg') || clean.endsWith('.svgz')) return 'image/svg+xml'
  if (clean.endsWith('.bmp')) return 'image/bmp'
  if (clean.endsWith('.ico')) return 'image/x-icon'
  if (clean.endsWith('.tiff') || clean.endsWith('.tif')) return 'image/tiff'
  if (clean.endsWith('.avif')) return 'image/avif'
  if (clean.endsWith('.heic')) return 'image/heic'
  if (clean.endsWith('.heif')) return 'image/heif'
  if (clean.endsWith('.apng')) return 'image/apng'
  return undefined
}

/** Helper: parse Data URI */
export function parseImageDataUrl(url: string): { data: string; mimeType: string } | undefined {
  if (!url.startsWith('data:')) return undefined
  const commaIdx = url.indexOf(',')
  if (commaIdx === -1) return undefined
  const header = url.slice(5, commaIdx)
  const raw = url.slice(commaIdx + 1).trim()
  const parts = header.split(';')
  const mimeType = parts[0] && parts[0].trim() !== '' ? parts[0].trim().toLowerCase() : 'image/png'
  if (!mimeType.startsWith('image/')) return undefined
  const isBase64 = parts.some(p => p.trim() === 'base64')
  let data: string
  if (isBase64) {
    data = raw.replace(/\s+/g, '')
  } else {
    try {
      const decoded = decodeURIComponent(raw)
      data = typeof Buffer !== 'undefined' ? Buffer.from(decoded).toString('base64') : btoa(decoded)
    } catch {
      data = typeof Buffer !== 'undefined' ? Buffer.from(raw).toString('base64') : btoa(raw)
    }
  }
  return { mimeType, data }
}

export function isLocalFilePath(str: string): boolean {
  if (typeof str !== 'string' || str === '') return false
  return isAbsolutePath(str) || str.startsWith('./') || str.startsWith('.\\') || str.startsWith('../') || str.startsWith('..\\')
}

/**
 * Detect image MIME type by examining binary magic numbers.
 * Supports Buffer, Uint8Array, and base64 strings.
 */
export function detectImageMimeFromMagic(raw: Buffer | Uint8Array | string | undefined): string | undefined {
  if (!raw) return undefined
  let bytes: Uint8Array | undefined
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('<svg') || (trimmed.startsWith('<?xml') && trimmed.includes('<svg'))) {
      return 'image/svg+xml'
    }
    try {
      const prefix = trimmed.slice(0, 64).replace(/\s+/g, '')
      if (typeof Buffer !== 'undefined') {
        bytes = Buffer.from(prefix, 'base64')
      } else if (typeof atob !== 'undefined') {
        const bin = atob(prefix)
        bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      }
    } catch {
      return undefined
    }
  } else if (raw instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw))) {
    bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  }

  if (!bytes || bytes.length < 3) return undefined

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  // GIF: GIF87a or GIF89a (47 49 46 38)
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }

  // WebP: RIFF....WEBP (52 49 46 46 .... 57 45 42 50)
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }

  // BMP: 42 4D ("BM")
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp'
  }

  // ICO: 00 00 01 00
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return 'image/x-icon'
  }

  // TIFF: II*. (49 49 2A 00) or MM.* (4D 4D 00 2A)
  if (bytes.length >= 4 &&
      ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
       (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) {
    return 'image/tiff'
  }

  // AVIF / HEIC: ftyp box at offset 4 (bytes 4..7 === 'ftyp')
  if (bytes.length >= 12 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase()
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'mif1' || brand === 'msf1') return 'image/heic'
  }

  return undefined
}

function toBase64(data: Buffer | Uint8Array | string): string {
  if (typeof data === 'string') return data.replace(/\s+/g, '')
  if (typeof Buffer !== 'undefined') return Buffer.from(data).toString('base64')
  let binary = ''
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Extract an image payload (Base64 data + MIME type) from an image block and optional context.
 */
export function resolveImageContent(block: unknown, context?: unknown): PromptImageContent | undefined {
  if (!block || typeof block !== 'object') return undefined
  const b = block as Record<string, unknown>
  const attRecord = b.attachment && typeof b.attachment === 'object' ? (b.attachment as Record<string, unknown>) : undefined
  const isExplicitImageBlock = b.type === 'image' || b.type === 'image_url' || b.type === 'attachment'
  const explicitMime = (typeof attRecord?.mediaType === 'string' && attRecord.mediaType.trim().toLowerCase()) ||
    (typeof attRecord?.mimeType === 'string' && attRecord.mimeType.trim().toLowerCase()) ||
    (typeof b.mediaType === 'string' && b.mediaType.trim().toLowerCase()) ||
    (typeof b.mimeType === 'string' && b.mimeType.trim().toLowerCase()) ||
    (typeof b.contentType === 'string' && b.contentType.trim().toLowerCase()) ||
    undefined

  // 1. Direct base64 data: { data: string | Buffer | Uint8Array, mimeType?: string }
  if (typeof b.data === 'string' && b.data.trim() !== '') {
    if (b.data.startsWith('data:')) {
      const parsed = parseImageDataUrl(b.data)
      if (parsed) {
        const mimeType = explicitMime || parsed.mimeType || detectImageMimeFromMagic(parsed.data) || 'image/png'
        return { type: 'image', data: parsed.data, mimeType, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
      }
      return undefined
    }
    const mimeType = explicitMime || detectImageMimeFromMagic(b.data) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) {
      return {
        type: 'image',
        data: b.data.trim().replace(/\s+/g, ''),
        mimeType,
        ...(typeof b.uri === 'string' ? { uri: b.uri } : {}),
      }
    }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b.data)) {
    const mimeType = explicitMime || detectImageMimeFromMagic(b.data) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) {
      return { type: 'image', data: b.data.toString('base64'), mimeType, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
    }
  }
  if (b.data instanceof Uint8Array) {
    const mimeType = explicitMime || detectImageMimeFromMagic(b.data) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) {
      return { type: 'image', data: toBase64(b.data), mimeType, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
    }
  }

  // 2. Anthropic style: source: { type: 'base64', media_type: string, data: string }
  if (b.source && typeof b.source === 'object') {
    const src = b.source as Record<string, unknown>
    const srcMime = (typeof src.media_type === 'string' && src.media_type.trim().toLowerCase()) ||
      (typeof src.mimeType === 'string' && src.mimeType.trim().toLowerCase()) ||
      explicitMime ||
      (typeof src.data === 'string' || src.data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(src.data)) ? detectImageMimeFromMagic(src.data as Buffer | Uint8Array | string) : undefined) ||
      'image/png'
    if (srcMime.startsWith('image/')) {
      if (typeof src.data === 'string' && src.data.trim() !== '') {
        return {
          type: 'image',
          data: src.data.trim().replace(/\s+/g, ''),
          mimeType: srcMime,
          ...(typeof b.uri === 'string' ? { uri: b.uri } : {}),
        }
      }
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(src.data)) {
        return { type: 'image', data: src.data.toString('base64'), mimeType: srcMime, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
      }
      if (src.data instanceof Uint8Array) {
        return { type: 'image', data: toBase64(src.data), mimeType: srcMime, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
      }
    }
  }

  // 3. Image property: { image: string | Buffer | Uint8Array }
  if (typeof b.image === 'string' && b.image.trim() !== '') {
    if (b.image.startsWith('data:')) {
      const parsed = parseImageDataUrl(b.image)
      if (parsed) return { type: 'image', data: parsed.data, mimeType: explicitMime || parsed.mimeType || detectImageMimeFromMagic(parsed.data) || 'image/png' }
      return undefined
    }
    const mimeType = explicitMime || detectImageMimeFromMagic(b.image) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) {
      return { type: 'image', data: b.image.trim().replace(/\s+/g, ''), mimeType }
    }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b.image)) {
    const mimeType = explicitMime || detectImageMimeFromMagic(b.image) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) return { type: 'image', data: b.image.toString('base64'), mimeType }
  }
  if (b.image instanceof Uint8Array) {
    const mimeType = explicitMime || detectImageMimeFromMagic(b.image) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) return { type: 'image', data: toBase64(b.image), mimeType }
  }

  // 4. OpenAI style image_url: { image_url: string | { url: string } }
  if (b.image_url) {
    const urlStr = typeof b.image_url === 'string'
      ? b.image_url
      : (typeof b.image_url === 'object' && b.image_url !== null ? (b.image_url as Record<string, unknown>).url : undefined)
    if (typeof urlStr === 'string' && urlStr.trim() !== '') {
      if (urlStr.startsWith('data:')) {
        const parsed = parseImageDataUrl(urlStr)
        if (parsed) return { type: 'image', data: parsed.data, mimeType: explicitMime || parsed.mimeType || detectImageMimeFromMagic(parsed.data) || 'image/png', uri: urlStr }
        return undefined
      }
      if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
        const mimeType = explicitMime || guessImageMimeType(urlStr) || 'image/png'
        return { type: 'image', data: '', mimeType, uri: urlStr }
      }
      if (urlStr.startsWith('file://') || isLocalFilePath(urlStr)) {
        const fileContent = readImageFileFromContext(urlStr, context)
        if (fileContent !== undefined) {
          let data: string
          let resolvedMime: string | undefined
          if (typeof fileContent === 'string') {
            if (fileContent.startsWith('data:')) {
              const parsed = parseImageDataUrl(fileContent)
              if (parsed) {
                data = parsed.data
                resolvedMime = parsed.mimeType
              } else {
                return undefined
              }
            } else {
              data = fileContent.trim().replace(/\s+/g, '')
            }
          } else {
            data = toBase64(fileContent)
          }
          const mimeType = explicitMime || resolvedMime || guessImageMimeType(urlStr) || detectImageMimeFromMagic(fileContent) || (isExplicitImageBlock ? 'image/png' : undefined)
          if (mimeType && mimeType.startsWith('image/')) {
            return { type: 'image', data, mimeType, uri: urlStr }
          }
        }
      }
    }
  }

  // 5. Direct buffer / content on block: { buffer: Buffer } or { content: Buffer }
  if (b.buffer && (typeof Buffer !== 'undefined' && Buffer.isBuffer(b.buffer) || b.buffer instanceof Uint8Array)) {
    const data = typeof Buffer !== 'undefined' && Buffer.isBuffer(b.buffer) ? b.buffer.toString('base64') : toBase64(b.buffer as Uint8Array)
    const mimeType = explicitMime || detectImageMimeFromMagic(b.buffer as Buffer | Uint8Array) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) {
      return { type: 'image', data, mimeType, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
    }
  }
  if (b.content && (typeof Buffer !== 'undefined' && Buffer.isBuffer(b.content) || b.content instanceof Uint8Array)) {
    const data = typeof Buffer !== 'undefined' && Buffer.isBuffer(b.content) ? b.content.toString('base64') : toBase64(b.content as Uint8Array)
    const mimeType = explicitMime || detectImageMimeFromMagic(b.content as Buffer | Uint8Array) || (isExplicitImageBlock ? 'image/png' : undefined)
    if (mimeType && mimeType.startsWith('image/')) {
      return { type: 'image', data, mimeType, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
    }
  }

  // 6. Data URL or Remote URL in `url`
  if (typeof b.url === 'string') {
    if (b.url.startsWith('data:')) {
      const parsed = parseImageDataUrl(b.url)
      if (parsed) return { type: 'image', data: parsed.data, mimeType: explicitMime || parsed.mimeType || detectImageMimeFromMagic(parsed.data) || 'image/png', uri: b.url }
      return undefined
    }
    if (b.url.startsWith('http://') || b.url.startsWith('https://')) {
      const mimeType = explicitMime || guessImageMimeType(b.url) || 'image/png'
      return { type: 'image', data: '', mimeType, uri: b.url }
    }
  }

  // 7. File path in `path`, `filePath`, or `url: file://...`
  let filePath: string | undefined
  if (typeof b.path === 'string' && b.path !== '') filePath = b.path
  else if (typeof b.filePath === 'string' && b.filePath !== '') filePath = b.filePath
  else if (typeof b.url === 'string' && (b.url.startsWith('file://') || isLocalFilePath(b.url))) filePath = b.url

  if (filePath !== undefined) {
    const fileContent = readImageFileFromContext(filePath, context)
    if (fileContent !== undefined) {
      let data: string
      let resolvedMime: string | undefined
      if (typeof fileContent === 'string') {
        if (fileContent.startsWith('data:')) {
          const parsed = parseImageDataUrl(fileContent)
          if (parsed) {
            data = parsed.data
            resolvedMime = parsed.mimeType
          } else {
            return undefined
          }
        } else {
          data = fileContent.trim().replace(/\s+/g, '')
        }
      } else {
        data = toBase64(fileContent)
      }
      const mimeType = explicitMime ||
        resolvedMime ||
        guessImageMimeType(filePath) ||
        detectImageMimeFromMagic(fileContent) ||
        (isExplicitImageBlock ? 'image/png' : undefined)

      if (mimeType && mimeType.startsWith('image/')) {
        let uri = typeof b.url === 'string' ? b.url : undefined
        if (!uri) {
          if (filePath.startsWith('file://')) {
            uri = filePath
          } else if (isAbsolutePath(filePath)) {
            if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
              uri = `file://${filePath.replace(/^[\/\\]+/, '').replace(/\\/g, '/')}`
            } else if (/^[a-zA-Z]:/.test(filePath)) {
              uri = `file:///${filePath.replace(/\\/g, '/')}`
            } else {
              uri = `file://${filePath.startsWith('/') ? filePath : `/${filePath}`}`
            }
          } else {
            uri = filePath
          }
        }
        return {
          type: 'image',
          data,
          mimeType,
          uri,
        }
      }
    }
  }

  // 8. Attachment resolution via context
  let attachmentId: string | undefined
  if (attRecord && typeof attRecord.attachmentId === 'string' && attRecord.attachmentId.trim() !== '') {
    attachmentId = attRecord.attachmentId.trim()
  } else if (typeof b.attachmentId === 'string' && b.attachmentId.trim() !== '') {
    attachmentId = b.attachmentId.trim()
  } else if (attRecord && typeof attRecord.id === 'string' && attRecord.id.trim() !== '') {
    attachmentId = attRecord.id.trim()
  } else if (typeof b.id === 'string' && b.id.trim() !== '') {
    attachmentId = b.id.trim()
  } else if (typeof b.attachment === 'string' && b.attachment.trim() !== '') {
    attachmentId = b.attachment.trim()
  } else if (typeof b.url === 'string' && b.url.startsWith('attachment:')) {
    attachmentId = b.url.replace(/^attachment:\/\/|^attachment:/, '')
  } else if (typeof b.image_url === 'string' && b.image_url.startsWith('attachment:')) {
    attachmentId = b.image_url.replace(/^attachment:\/\/|^attachment:/, '')
  } else if (b.image_url && typeof b.image_url === 'object' && typeof (b.image_url as Record<string, unknown>).url === 'string' && ((b.image_url as Record<string, unknown>).url as string).startsWith('attachment:')) {
    attachmentId = ((b.image_url as Record<string, unknown>).url as string).replace(/^attachment:\/\/|^attachment:/, '')
  }

  if (attachmentId !== undefined) {
    const rawAtt = resolveImageAttachmentFromContext(attachmentId, context, b.attachment)
    if (rawAtt !== undefined) {
      if (typeof rawAtt === 'string') {
        if (rawAtt.startsWith('data:')) {
          const parsed = parseImageDataUrl(rawAtt)
          if (parsed) {
            const mimeType = explicitMime || parsed.mimeType || detectImageMimeFromMagic(parsed.data) || 'image/png'
            return {
              type: 'image',
              data: parsed.data,
              mimeType,
              uri: typeof b.uri === 'string' ? b.uri : `attachment://${attachmentId}`,
            }
          }
          return undefined
        } else if (rawAtt.startsWith('file://') || isLocalFilePath(rawAtt)) {
          const fileContent = readImageFileFromContext(rawAtt, context)
          if (fileContent !== undefined) {
            let data: string
            let resolvedMime: string | undefined
            if (typeof fileContent === 'string') {
              if (fileContent.startsWith('data:')) {
                const parsed = parseImageDataUrl(fileContent)
                if (parsed) {
                  data = parsed.data
                  resolvedMime = parsed.mimeType
                } else {
                  return undefined
                }
              } else {
                data = fileContent.trim().replace(/\s+/g, '')
              }
            } else {
              data = toBase64(fileContent)
            }
            const mimeType = explicitMime ||
              resolvedMime ||
              (typeof attRecord?.name === 'string' ? guessImageMimeType(attRecord.name) : undefined) ||
              guessImageMimeType(rawAtt) ||
              detectImageMimeFromMagic(fileContent) ||
              (isExplicitImageBlock ? 'image/png' : undefined)
            if (mimeType && mimeType.startsWith('image/')) {
              return { type: 'image', data, mimeType, uri: typeof b.uri === 'string' ? b.uri : `attachment://${attachmentId}` }
            }
          }
        }
        const mimeType = explicitMime ||
          (typeof attRecord?.name === 'string' ? guessImageMimeType(attRecord.name) : undefined) ||
          guessImageMimeType(attachmentId) ||
          detectImageMimeFromMagic(rawAtt) ||
          (isExplicitImageBlock ? 'image/png' : undefined)
        if (mimeType && mimeType.startsWith('image/')) {
          return { type: 'image', data: rawAtt.trim().replace(/\s+/g, ''), mimeType, uri: typeof b.uri === 'string' ? b.uri : `attachment://${attachmentId}` }
        }
      }
      if (typeof rawAtt === 'object' && rawAtt !== null) {
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(rawAtt)) {
          const mimeType = explicitMime ||
            (typeof attRecord?.name === 'string' ? guessImageMimeType(attRecord.name) : undefined) ||
            guessImageMimeType(attachmentId) ||
            detectImageMimeFromMagic(rawAtt) ||
            (isExplicitImageBlock ? 'image/png' : undefined)
          if (mimeType && mimeType.startsWith('image/')) {
            return {
              type: 'image',
              data: rawAtt.toString('base64'),
              mimeType,
              uri: typeof b.uri === 'string' ? b.uri : `attachment://${attachmentId}`,
            }
          }
        }
        if (rawAtt instanceof Uint8Array) {
          const mimeType = explicitMime ||
            (typeof attRecord?.name === 'string' ? guessImageMimeType(attRecord.name) : undefined) ||
            guessImageMimeType(attachmentId) ||
            detectImageMimeFromMagic(rawAtt) ||
            (isExplicitImageBlock ? 'image/png' : undefined)
          if (mimeType && mimeType.startsWith('image/')) {
            return {
              type: 'image',
              data: toBase64(rawAtt),
              mimeType,
              uri: typeof b.uri === 'string' ? b.uri : `attachment://${attachmentId}`,
            }
          }
        }
        const attObj = rawAtt as Record<string, unknown>
        let data: string | undefined
        let resolvedMime: string | undefined

        const attPath = typeof attObj.path === 'string' && attObj.path !== ''
          ? attObj.path
          : (typeof attObj.filePath === 'string' && attObj.filePath !== ''
              ? attObj.filePath
              : (typeof attObj.url === 'string' && (attObj.url.startsWith('file://') || isLocalFilePath(attObj.url)) ? attObj.url : undefined))

        let fileContentForMagic: Buffer | Uint8Array | string | undefined

        if (attPath !== undefined) {
          const fileContent = readImageFileFromContext(attPath, context)
          if (fileContent !== undefined) {
            fileContentForMagic = fileContent
            if (typeof fileContent === 'string') {
              if (fileContent.startsWith('data:')) {
                const parsed = parseImageDataUrl(fileContent)
                if (parsed) {
                  data = parsed.data
                  resolvedMime = parsed.mimeType
                }
              } else {
                data = fileContent.trim().replace(/\s+/g, '')
              }
            } else {
              data = toBase64(fileContent)
            }
            if (!resolvedMime) resolvedMime = guessImageMimeType(attPath)
          }
        }

        if (data === undefined) {
          if (typeof attObj.data === 'string' && attObj.data.trim() !== '') {
            if (attObj.data.startsWith('data:')) {
              const parsed = parseImageDataUrl(attObj.data)
              if (parsed) {
                data = parsed.data
                resolvedMime = parsed.mimeType
              }
            } else {
              data = attObj.data.trim().replace(/\s+/g, '')
              fileContentForMagic = attObj.data
            }
          }
          else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(attObj.data)) {
            data = attObj.data.toString('base64')
            fileContentForMagic = attObj.data
          }
          else if (attObj.data instanceof Uint8Array) {
            data = toBase64(attObj.data)
            fileContentForMagic = attObj.data
          }
          else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(attObj.buffer)) {
            data = attObj.buffer.toString('base64')
            fileContentForMagic = attObj.buffer
          }
          else if (attObj.buffer instanceof Uint8Array) {
            data = toBase64(attObj.buffer)
            fileContentForMagic = attObj.buffer
          }
          else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(attObj.content)) {
            data = attObj.content.toString('base64')
            fileContentForMagic = attObj.content
          }
          else if (attObj.content instanceof Uint8Array) {
            data = toBase64(attObj.content)
            fileContentForMagic = attObj.content
          }
          else if (typeof attObj.content === 'string') {
            if (attObj.content.startsWith('data:')) {
              const parsed = parseImageDataUrl(attObj.content)
              if (parsed) {
                data = parsed.data
                resolvedMime = parsed.mimeType
              }
            } else {
              data = attObj.content.trim().replace(/\s+/g, '')
              fileContentForMagic = attObj.content
            }
          }
        }

        if (data !== undefined) {
          const mimeType = explicitMime ||
            (typeof attObj.mediaType === 'string' && attObj.mediaType.toLowerCase()) ||
            (typeof attObj.mimeType === 'string' && attObj.mimeType.toLowerCase()) ||
            resolvedMime ||
            (typeof attRecord?.name === 'string' ? guessImageMimeType(attRecord.name) : undefined) ||
            (typeof attObj.name === 'string' ? guessImageMimeType(attObj.name as string) : undefined) ||
            guessImageMimeType(attachmentId) ||
            detectImageMimeFromMagic(fileContentForMagic ?? data) ||
            (isExplicitImageBlock ? 'image/png' : undefined)
          if (mimeType && mimeType.startsWith('image/')) {
            return {
              type: 'image',
              data,
              mimeType,
              uri: typeof b.uri === 'string' ? b.uri : `attachment://${attachmentId}`,
            }
          }
        }
      }
    }
  }

  // 9. Direct b.attachment object
  if (b.attachment && typeof b.attachment === 'object') {
    const attObj = b.attachment as Record<string, unknown>
    let data: string | undefined
    let resolvedMime: string | undefined

    const attPath = typeof attObj.path === 'string' && attObj.path !== ''
      ? attObj.path
      : (typeof attObj.filePath === 'string' && attObj.filePath !== ''
          ? attObj.filePath
          : (typeof attObj.url === 'string' && (attObj.url.startsWith('file://') || isLocalFilePath(attObj.url)) ? attObj.url : undefined))

    let fileContentForMagic: Buffer | Uint8Array | string | undefined

    if (attPath !== undefined) {
      const fileContent = readImageFileFromContext(attPath, context)
      if (fileContent !== undefined) {
        fileContentForMagic = fileContent
        if (typeof fileContent === 'string') {
          if (fileContent.startsWith('data:')) {
            const parsed = parseImageDataUrl(fileContent)
            if (parsed) {
              data = parsed.data
              resolvedMime = parsed.mimeType
            }
          } else {
            data = fileContent.trim().replace(/\s+/g, '')
          }
        } else {
          data = toBase64(fileContent)
        }
        if (!resolvedMime) resolvedMime = guessImageMimeType(attPath)
      }
    }

    if (data === undefined) {
      if (typeof attObj.data === 'string' && attObj.data.trim() !== '') {
        if (attObj.data.startsWith('data:')) {
          const parsed = parseImageDataUrl(attObj.data)
          if (parsed) {
            data = parsed.data
            resolvedMime = parsed.mimeType
          }
        } else {
          data = attObj.data.trim().replace(/\s+/g, '')
          fileContentForMagic = attObj.data
        }
      }
      else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(attObj.data)) {
        data = attObj.data.toString('base64')
        fileContentForMagic = attObj.data
      }
      else if (attObj.data instanceof Uint8Array) {
        data = toBase64(attObj.data)
        fileContentForMagic = attObj.data
      }
      else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(attObj.buffer)) {
        data = attObj.buffer.toString('base64')
        fileContentForMagic = attObj.buffer
      }
      else if (attObj.buffer instanceof Uint8Array) {
        data = toBase64(attObj.buffer)
        fileContentForMagic = attObj.buffer
      }
      else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(attObj.content)) {
        data = attObj.content.toString('base64')
        fileContentForMagic = attObj.content
      }
      else if (attObj.content instanceof Uint8Array) {
        data = toBase64(attObj.content)
        fileContentForMagic = attObj.content
      }
      else if (typeof attObj.content === 'string') {
        if (attObj.content.startsWith('data:')) {
          const parsed = parseImageDataUrl(attObj.content)
          if (parsed) {
            data = parsed.data
            resolvedMime = parsed.mimeType
          }
        } else {
          data = attObj.content.trim().replace(/\s+/g, '')
          fileContentForMagic = attObj.content
        }
      }
    }

    if (data !== undefined) {
      const mimeType = explicitMime ||
        (typeof attObj.mediaType === 'string' && attObj.mediaType.toLowerCase()) ||
        (typeof attObj.mimeType === 'string' && attObj.mimeType.toLowerCase()) ||
        resolvedMime ||
        (typeof attObj.name === 'string' ? guessImageMimeType(attObj.name as string) : undefined) ||
        (attPath ? guessImageMimeType(attPath) : undefined) ||
        detectImageMimeFromMagic(fileContentForMagic ?? data) ||
        (isExplicitImageBlock ? 'image/png' : undefined)
      if (mimeType && mimeType.startsWith('image/')) {
        return { type: 'image', data, mimeType, ...(typeof b.uri === 'string' ? { uri: b.uri } : {}) }
      }
    }
  }

  return undefined
}
