/**
 * Image payload resolution, first half: base64 blocks, data URLs, file paths, attachment maps and content ordering. Cases stay under the original `selectForwardPrompt` describe because that is the function under test.
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  isLocalFilePath,
  normalizeFileUrlToPath,
  selectForwardPrompt,
} from '../../src/impl.ts'

describe('selectForwardPrompt (host request → forwarded ACP prompt)', () => {
  const user = (text: string, id = 'u1') => ({ role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const injected = (kind: string, text: string) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })

  it('extracts direct base64 image blocks and populates images and content arrays', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        id: 'msg-img',
        content: [
          { type: 'text', text: 'look at this image' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      id: 'msg-img',
      text: 'look at this image',
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      content: [
        { type: 'text', text: 'look at this image' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })
  })

  it('parses data URLs and anthropic source image blocks', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRiQAAABXRUJQVlA=' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg', uri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
        { type: 'image', data: 'UklGRiQAAABXRUJQVlA=', mimeType: 'image/webp' },
      ],
      content: [
        { type: 'image', data: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg', uri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
        { type: 'image', data: 'UklGRiQAAABXRUJQVlA=', mimeType: 'image/webp' },
      ],
    })
  })

  it('reads file paths via context readFile and resolves MIME types', () => {
    const context = {
      readFile: (path: string) => (path === '/workspace/test.png' ? Buffer.from('mock-png-binary') : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'analyze diagram' },
          { type: 'image', path: '/workspace/test.png' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'analyze diagram',
      images: [
        {
          type: 'image',
          data: Buffer.from('mock-png-binary').toString('base64'),
          mimeType: 'image/png',
          uri: 'file:///workspace/test.png',
        },
      ],
      content: [
        { type: 'text', text: 'analyze diagram' },
        {
          type: 'image',
          data: Buffer.from('mock-png-binary').toString('base64'),
          mimeType: 'image/png',
          uri: 'file:///workspace/test.png',
        },
      ],
    })
  })

  it('resolves attachments from context service or map', () => {
    const context = {
      attachments: {
        'att-1': { data: 'YXR0MWJhc2U2NA==', mimeType: 'image/gif' },
      },
      getAttachment: (id: string) => (id === 'att-2' ? Buffer.from('att2-bytes') : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachmentId: 'att-1' },
          { type: 'image', attachment: { id: 'att-2' } },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'YXR0MWJhc2U2NA==', mimeType: 'image/gif', uri: 'attachment://att-1' },
        { type: 'image', data: Buffer.from('att2-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-2' },
      ],
      content: [
        { type: 'image', data: 'YXR0MWJhc2U2NA==', mimeType: 'image/gif', uri: 'attachment://att-1' },
        { type: 'image', data: Buffer.from('att2-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-2' },
      ],
    })
  })

  it('preserves interleaved order of text and image content blocks', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'step 1' },
          { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
          { type: 'text', text: 'step 2' },
          { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'step 1\nstep 2',
      images: [
        { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
        { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' },
      ],
      content: [
        { type: 'text', text: 'step 1' },
        { type: 'image', data: 'aW1nMQ==', mimeType: 'image/png' },
        { type: 'text', text: 'step 2' },
        { type: 'image', data: 'aW1nMg==', mimeType: 'image/jpeg' },
      ],
    })
  })

  it('validates local file paths complying with Rule 24 and cross-platform paths', () => {
    expect(isLocalFilePath('/absolute/posix/path.png')).toBe(true)
    expect(isLocalFilePath('C:\\Windows\\test.png')).toBe(true)
    expect(isLocalFilePath('D:/workspace/test.png')).toBe(true)
    expect(isLocalFilePath('\\\\server\\share\\img.png')).toBe(true)
    expect(isLocalFilePath('//server/share/img.png')).toBe(true)
    expect(isLocalFilePath('./relative.png')).toBe(true)
    expect(isLocalFilePath('../parent.png')).toBe(true)
    expect(isLocalFilePath('..\\parent.png')).toBe(true)
    expect(isLocalFilePath('\\\\?\\C:\\device')).toBe(false)
    expect(isLocalFilePath('not-a-path')).toBe(false)
    expect(isLocalFilePath('')).toBe(false)
  })

  it('normalizes file URLs to absolute paths on POSIX and Windows', () => {
    expect(normalizeFileUrlToPath('file:///workspace/test.png')).toBe('/workspace/test.png')
    expect(normalizeFileUrlToPath('file://localhost/workspace/test.png')).toBe('/workspace/test.png')
    expect(normalizeFileUrlToPath('file:///C:/workspace/test.png')).toBe('C:/workspace/test.png')
    expect(normalizeFileUrlToPath('file://localhost/C:/workspace/test.png')).toBe('C:/workspace/test.png')
    expect(normalizeFileUrlToPath('file://C:/workspace/test.png')).toBe('C:/workspace/test.png')
    expect(normalizeFileUrlToPath('file:///C:/My%20Documents/test%201.png')).toBe('C:/My Documents/test 1.png')
    expect(normalizeFileUrlToPath('file:///workspace/%E6%B5%8B%E8%AF%95.png')).toBe('/workspace/测试.png')
    expect(normalizeFileUrlToPath('file://server/share/test.png')).toBe('//server/share/test.png')
    expect(normalizeFileUrlToPath('file://server/share/My%20Photo.png')).toBe('//server/share/My Photo.png')
    expect(normalizeFileUrlToPath('/plain/path.png')).toBe('/plain/path.png')
  })

  it('parses OpenAI style image_url blocks and raw base64 image strings', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,b3BlbmFpaW1n' } },
          { type: 'image', image: 'cmF3YmFzZTY0' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'b3BlbmFpaW1n', mimeType: 'image/png', uri: 'data:image/png;base64,b3BlbmFpaW1n' },
        { type: 'image', data: 'cmF3YmFzZTY0', mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: 'b3BlbmFpaW1n', mimeType: 'image/png', uri: 'data:image/png;base64,b3BlbmFpaW1n' },
        { type: 'image', data: 'cmF3YmFzZTY0', mimeType: 'image/png' },
      ],
    })
  })

  it('handles Buffer and Uint8Array image inputs', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', data: Buffer.from('buffer-data'), mimeType: 'image/jpeg' },
          { type: 'image', buffer: Buffer.from('buffer-prop'), mimeType: 'image/png' },
          { type: 'image', content: new Uint8Array([1, 2, 3]) },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: Buffer.from('buffer-data').toString('base64'), mimeType: 'image/jpeg' },
        { type: 'image', data: Buffer.from('buffer-prop').toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: Buffer.from('buffer-data').toString('base64'), mimeType: 'image/jpeg' },
        { type: 'image', data: Buffer.from('buffer-prop').toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
      ],
    })
  })

  it('converts non-base64 data URL to base64 encoding', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>' },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        {
          type: 'image',
          data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
          mimeType: 'image/svg+xml',
          uri: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
        },
      ],
      content: [
        {
          type: 'image',
          data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
          mimeType: 'image/svg+xml',
          uri: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
        },
      ],
    })
  })

  it('strips Data URL header and parses MIME in attachment objects', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { data: 'data:image/webp;base64,d2VicGRhdGE=' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'd2VicGRhdGE=', mimeType: 'image/webp' },
      ],
      content: [
        { type: 'image', data: 'd2VicGRhdGE=', mimeType: 'image/webp' },
      ],
    })
  })

  it('resolves attachment pointing to a local file path', () => {
    const context = {
      readFile: (p: string) => (p === '/cache/att.png' ? Buffer.from('png-bytes') : undefined),
      attachments: {
        'att-path-1': '/cache/att.png',
        'att-path-2': { path: '/cache/att.png' },
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachmentId: 'att-path-1' },
          { type: 'image', attachmentId: 'att-path-2' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-1' },
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-2' },
      ],
      content: [
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-1' },
        { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', uri: 'attachment://att-path-2' },
      ],
    })
  })

  it('preserves caller mimeType on attachment blocks over guessed fallback', () => {
    const context = {
      attachments: {
        'uuid-123': 'YXR0Ynl0ZXM=',
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', attachmentId: 'uuid-123', mimeType: 'image/webp' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'YXR0Ynl0ZXM=', mimeType: 'image/webp', uri: 'attachment://uuid-123' },
      ],
      content: [
        { type: 'image', data: 'YXR0Ynl0ZXM=', mimeType: 'image/webp', uri: 'attachment://uuid-123' },
      ],
    })
  })

  it('supports message.parts structure and type attachment with image mimeType', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'question' },
          { type: 'attachment', mimeType: 'image/png', data: 'aW1n' },
        ],
      } as never,
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'question',
      images: [
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
      content: [
        { type: 'text', text: 'question' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
    })
  })

  it('handles string content safely without throwing TypeError', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: 'plain string content' as never,
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: 'plain string content',
    })
  })

  it('extracts image from type file with recognized image extension', () => {
    const context = {
      readFile: (p: string) => (p === '/work/screenshot.png' ? Buffer.from('img-bytes') : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'file', path: '/work/screenshot.png' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: Buffer.from('img-bytes').toString('base64'), mimeType: 'image/png', uri: 'file:///work/screenshot.png' },
      ],
      content: [
        { type: 'image', data: Buffer.from('img-bytes').toString('base64'), mimeType: 'image/png', uri: 'file:///work/screenshot.png' },
      ],
    })
  })

  it('extracts image from type attachment with nested attachment object', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'attachment', attachment: { id: 'a1', mimeType: 'image/png', data: 'dGVzdA==' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'dGVzdA==', mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: 'dGVzdA==', mimeType: 'image/png' },
      ],
    })
  })

  it('extracts image from type attachment with attachmentId via context lookup', () => {
    const context = {
      attachments: {
        'att-ctx': { data: 'YXR0Y29udGV4dA==', mimeType: 'image/webp' },
      },
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'attachment', attachmentId: 'att-ctx' },
        ],
      },
    ], context)
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'YXR0Y29udGV4dA==', mimeType: 'image/webp', uri: 'attachment://att-ctx' },
      ],
      content: [
        { type: 'image', data: 'YXR0Y29udGV4dA==', mimeType: 'image/webp', uri: 'attachment://att-ctx' },
      ],
    })
  })

  it('does not treat non-image files or non-image data URLs as images', () => {
    const context = {
      readFile: (p: string) => (p === '/work/notes.txt' ? 'hello plain text' : undefined),
    }
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'file', path: '/work/notes.txt' },
          { type: 'image', data: 'data:application/pdf;base64,JVBERi0xLjQK' },
        ],
      },
    ], context)
    expect(picked).toEqual({ kind: 'no-user-input' })
  })

  it('supports remote HTTP/HTTPS image URLs by retaining uri', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: [
          { type: 'image', url: 'https://example.com/cat.png' },
          { type: 'image_url', image_url: { url: 'http://example.com/dog.jpg' } },
        ],
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: '', mimeType: 'image/png', uri: 'https://example.com/cat.png' },
        { type: 'image', data: '', mimeType: 'image/jpeg', uri: 'http://example.com/dog.jpg' },
      ],
      content: [
        { type: 'image', data: '', mimeType: 'image/png', uri: 'https://example.com/cat.png' },
        { type: 'image', data: '', mimeType: 'image/jpeg', uri: 'http://example.com/dog.jpg' },
      ],
    })
  })

  it('supports single-object message content', () => {
    const picked = selectForwardPrompt([
      {
        role: 'user',
        content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      },
    ])
    expect(picked).toEqual({
      kind: 'prompt',
      text: '',
      images: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
      content: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })
  })

})
