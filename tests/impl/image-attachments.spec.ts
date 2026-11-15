/**
 * Image payload resolution, second half: the real DSH attachment store (`imageHostPath` / `readImage`), the `~/.dsh/attachments` disk layout, magic-number detection and hostile context traps.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  resolveImageAttachmentFromContext,
  selectForwardPrompt,
  detectImageMimeFromMagic,
} from '../../src/impl.ts'

describe('selectForwardPrompt (host request → forwarded ACP prompt)', () => {
  const user = (text: string, id = 'u1') => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const injected = (kind: string, text: string) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })

  it('resolves real DSH attachment structure using store imageHostPath and maps mediaType to mimeType', () => {
    const rawImageBytes = Buffer.from('png-host-content')
    const context = {
      imageHostPath: (ref: unknown) => {
        if (typeof ref === 'string' && ref.includes('1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796')) {
          return '/dsh/cache/1f4e8f.png'
        }
        return undefined
      },
      readFile: (p: string) => (p === '/dsh/cache/1f4e8f.png' ? rawImageBytes : undefined),
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796',
              mediaType: 'image/png',
              width: 128,
              height: 92,
              bytes: 2216,
              name: 'image.png',
            },
          },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: rawImageBytes.toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796',
        },
      ],
      content: [
        {
          type: 'image',
          data: rawImageBytes.toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796',
        },
      ],
    })
  })

  it('resolves DSH attachment using store readImage returning Uint8Array synchronously', () => {
    const rawBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const context = {
      readImage: (ref: unknown) => {
        return { ref, data: rawBytes }
      },
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
              mediaType: 'image/png',
            },
          },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: Buffer.from(rawBytes).toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        },
      ],
      content: [
        {
          type: 'image',
          data: Buffer.from(rawBytes).toString('base64'),
          mimeType: 'image/png',
          uri: 'attachment://sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
        },
      ],
    })
  })

  it('falls back to store-free disk lookup at ~/.dsh/attachments/v1/objects/<hash[0..1]>/<hash>', () => {
    const hash = '1f4e8f2d9e96479ec762b46f8d6b946bed452bba976ca1092abd773bd0fb3796'
    const diskBytes = Buffer.from('disk-attachment-bytes')
    let queriedPath: string | undefined

    const context = {
      readFile: (p: string) => {
        queriedPath = p
        if (p.includes(`attachments/v1/objects/1f/${hash}`) || p.includes(`attachments\\v1\\objects\\1f\\${hash}`)) {
          return diskBytes
        }
        return undefined
      },
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${hash}`,
              mediaType: 'image/webp',
            },
          },
        ],
      },
    ], context)

    expect(queriedPath).toBeDefined()
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: diskBytes.toString('base64'),
          mimeType: 'image/webp',
          uri: `attachment://sha256:${hash}`,
        },
      ],
      content: [
        {
          type: 'image',
          data: diskBytes.toString('base64'),
          mimeType: 'image/webp',
          uri: `attachment://sha256:${hash}`,
        },
      ],
    })
  })

  it('detects MIME type from magic numbers when mediaType and mimeType are absent', () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const context = {
      attachments: {
        'img-magic-jpeg': { data: jpegBytes },
      },
    }

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: 'img-magic-jpeg',
            },
          },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: jpegBytes.toString('base64'),
          mimeType: 'image/jpeg',
          uri: 'attachment://img-magic-jpeg',
        },
      ],
      content: [
        {
          type: 'image',
          data: jpegBytes.toString('base64'),
          mimeType: 'image/jpeg',
          uri: 'attachment://img-magic-jpeg',
        },
      ],
    })
  })

  it('respects attachmentId extraction precedence (b.attachment.attachmentId > b.attachmentId > b.attachment.id > b.id)', () => {
    const context = {
      attachments: {
        'id-att-field': { data: 'YXR0MQ==', mimeType: 'image/png' },
        'id-top-att': { data: 'YXR0Mg==', mimeType: 'image/png' },
        'id-nested-id': { data: 'YXR0Mw==', mimeType: 'image/png' },
        'id-top-id': { data: 'YXR0NA==', mimeType: 'image/png' },
      },
    }

    // 1. b.attachment.attachmentId wins over b.attachmentId
    const pick1 = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachmentId: 'id-top-att',
            attachment: {
              attachmentId: 'id-att-field',
              id: 'id-nested-id',
            },
            id: 'id-top-id',
          },
        ],
      },
    ], context)
    expect(pick1).toMatchObject({
      images: [{ uri: 'attachment://id-att-field', data: 'YXR0MQ==' }],
    })

    // 2. b.attachmentId wins over b.attachment.id
    const pick2 = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachmentId: 'id-top-att',
            attachment: {
              id: 'id-nested-id',
            },
            id: 'id-top-id',
          },
        ],
      },
    ], context)
    expect(pick2).toMatchObject({
      images: [{ uri: 'attachment://id-top-att', data: 'YXR0Mg==' }],
    })

    // 3. b.attachment.id wins over b.id
    const pick3 = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              id: 'id-nested-id',
            },
            id: 'id-top-id',
          },
        ],
      },
    ], context)
    expect(pick3).toMatchObject({
      images: [{ uri: 'attachment://id-nested-id', data: 'YXR0Mw==' }],
    })
  })

  it('extracts DSH image interleaved with text blocks in order', () => {
    const context = {
      attachments: {
        'sha256:dsh-img': { data: 'aGVsbG8=', mimeType: 'image/png' },
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Step 1: Check this screenshot' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:dsh-img',
              mediaType: 'image/png',
            },
          },
          { type: 'text', text: 'Step 2: Finish' },
        ],
      },
    ], context)

    expect(picked).toEqual({
      kind: 'prompt',
      text: 'Step 1: Check this screenshot\nStep 2: Finish',
      images: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', uri: 'attachment://sha256:dsh-img' },
      ],
      content: [
        { type: 'text', text: 'Step 1: Check this screenshot' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', uri: 'attachment://sha256:dsh-img' },
        { type: 'text', text: 'Step 2: Finish' },
      ],
    })
  })

  it('detects multiple image formats using detectImageMimeFromMagic or falls back to image/png', () => {
    // PNG
    expect(detectImageMimeFromMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    // JPEG
    expect(detectImageMimeFromMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    // GIF
    expect(detectImageMimeFromMagic(Buffer.from('GIF89a'))).toBe('image/gif')
    // WebP
    expect(detectImageMimeFromMagic(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    // BMP
    expect(detectImageMimeFromMagic(Buffer.from([0x42, 0x4d, 0, 0]))).toBe('image/bmp')
    // SVG text
    expect(detectImageMimeFromMagic('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('image/svg+xml')
    // Unknown bytes
    expect(detectImageMimeFromMagic(Buffer.from([0x01, 0x02, 0x03]))).toBeUndefined()
    expect(detectImageMimeFromMagic(undefined)).toBeUndefined()
  })

  it('safely extracts attachment through LocalAttachmentStore-like class preserving this.root', () => {
    class MockLocalAttachmentStore {
      root = 'M:/mock/dsh/attachments/v1'

      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== 'M:/mock/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref?.attachmentId))
        if (!match) throw new Error('INVALID_ATTACHMENT_REF')
        return `${this.root}/objects/${match[1].slice(0, 2)}/${match[1]}`
      }

      async readImage(ref: { attachmentId?: string }) {
        if (!this || this.root !== 'M:/mock/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        throw new Error('ATTACHMENT_NOT_FOUND')
      }
    }

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const hash = 'a'.repeat(64)
    const store = new MockLocalAttachmentStore()
    const childContext = Object.assign(Object.create(store), {
      readFile: (p: string) => {
        if (p === `M:/mock/dsh/attachments/v1/objects/aa/${hash}`) {
          return pngHeader
        }
        return undefined
      },
    })

    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${hash}`,
              mediaType: 'image/png',
            },
          },
        ],
      },
    ], childContext)

    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: pngHeader.toString('base64'),
          mimeType: 'image/png',
          uri: `attachment://sha256:${hash}`,
        },
      ],
      content: [
        {
          type: 'image',
          data: pngHeader.toString('base64'),
          mimeType: 'image/png',
          uri: `attachment://sha256:${hash}`,
        },
      ],
    })
  })

  it('handles async readImage rejection gracefully without unhandledRejection crash', async () => {
    let unhandledCaught = false
    const onUnhandled = () => {
      unhandledCaught = true
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      class FailingStore {
        root = '/root'
        imageHostPath() {
          throw new Error('no host path')
        }
        async readImage() {
          throw new Error('async image load failed')
        }
      }

      const store = new FailingStore()
      const res = resolveImageAttachmentFromContext('sha256:' + 'b'.repeat(64), store)
      expect(res).toBeUndefined()

      await new Promise(r => setTimeout(r, 10))
      expect(unhandledCaught).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('resolves attachments through ctx.get("attachments") service preserving rootContext for file reading', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const hash = 'c'.repeat(64)
    const expectedPath = `/dsh/attachments/v1/objects/cc/${hash}`

    class StoreService {
      root = '/dsh/attachments/v1'
      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== '/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        return expectedPath
      }
    }

    const serviceInstance = new StoreService()
    const ctx = {
      get(name: string) {
        if (name === 'attachments') return serviceInstance
        return undefined
      },
      readFile(p: string) {
        if (p === expectedPath) return pngHeader
        return undefined
      },
    }

    const res = resolveImageAttachmentFromContext(`sha256:${hash}`, ctx) as { path?: string; data?: Buffer }
    expect(res).toBeDefined()
    expect(res.path).toBe(expectedPath)
    expect(res.data).toEqual(pngHeader)
  })

  it('falls back to Symbol.for("cordis.original") when proxy method invocation throws', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const hash = 'd'.repeat(64)
    const expectedPath = `/dsh/attachments/v1/objects/dd/${hash}`

    class RealStoreInstance {
      root = '/dsh/attachments/v1'
      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== '/dsh/attachments/v1') {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        return expectedPath
      }
    }

    const realInstance = new RealStoreInstance()
    // Simulated Cordis proxy where the outer proxy throws, but cordis.original works
    const proxy = {
      imageHostPath() {
        throw new TypeError("Cannot read properties of undefined (reading 'root')")
      },
      [Symbol.for('cordis.original')]: realInstance,
    }

    const ctx = {
      get: (name: string) => (name === 'attachments' ? proxy : undefined),
      readFile: (p: string) => (p === expectedPath ? pngHeader : undefined),
    }

    const res = resolveImageAttachmentFromContext(`sha256:${hash}`, ctx) as { path?: string; data?: Buffer }
    expect(res).toBeDefined()
    expect(res.path).toBe(expectedPath)
    expect(res.data).toEqual(pngHeader)
  })

  it('safely handles context whose property getters throw "without inject" errors', () => {
    const cordisContextWithTraps = {
      get: () => undefined,
      get attachments(): never {
        throw new Error('cannot get property "attachments" without inject')
      },
      get attachmentService(): never {
        throw new Error('cannot get property "attachmentService" without inject')
      },
    }

    // Must not throw, fails open gracefully
    expect(() => resolveImageAttachmentFromContext('sha256:' + 'e'.repeat(64), cordisContextWithTraps)).not.toThrow()
    expect(resolveImageAttachmentFromContext('sha256:' + 'e'.repeat(64), cordisContextWithTraps)).toBeUndefined()
  })

})
