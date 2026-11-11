import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { BridgeManager } from '../../src/bridge.ts'
import { type AcpAgentDef, type StreamChunk } from '../../src/protocol.ts'
import { dispatchRpc, EventHub } from '../../src/impl.ts'
import { def, settleTranscript } from './harness.ts'

describe('image input transmission and capability validation (isolated manager)', () => {
  const imageRoot = mkdtempSync(join(tmpdir(), 'dsh-ntr-image-'))
  afterAll(() => {
    try {
      rmSync(imageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
  })

  const imageHub = new EventHub()
  const noImageDef: AcpAgentDef = {
    ...def,
    id: 'noimage',
    env: { ...def.env, MOCK_IMAGE: '0' },
  }
  const imageDef: AcpAgentDef = {
    ...def,
    id: 'hasimage',
    env: { ...def.env, MOCK_IMAGE: '1' },
  }

  it('intercepts prompt with image when agent does not support images', async () => {
    const gm = new BridgeManager([noImageDef], imageHub, 500, join(imageRoot, 'noimage-agents.json'))
    try {
      gm.bindChatAgent('dsh-noimage-sess', 'noimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'noimage',
        sessionId: 'dsh-noimage-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason).toMatchObject({
        kind: 'error',
        failure: {
          code: 'image_unsupported',
          message: expect.stringContaining('does not support image input'),
        },
      })
      // Provisional first turn lock is rolled back
      expect(gm.lockedAgentFor('dsh-noimage-sess')).toBeUndefined()
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('transmits image and text blocks when agent supports images', async () => {
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'image-agents.json'))
    try {
      gm.bindChatAgent('dsh-hasimage-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-hasimage-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'check image' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-hasimage-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('transmits image-only message (no text blocks) when agent supports images', async () => {
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'imageonly-agents.json'))
    try {
      gm.bindChatAgent('dsh-imgonly-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-imgonly-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-imgonly-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('AgentBridge.runPrompt throws image_unsupported directly if agent lacks capability', async () => {
    const gm = new BridgeManager([noImageDef], imageHub, 500, join(imageRoot, 'direct-agents.json'))
    try {
      const { sessionId } = await gm.startSession('noimage', undefined)
      const located = await gm.locateOrResume(sessionId)
      await expect(
        located.bridge.runPrompt(
          located.session,
          [
            { type: 'text', text: 'hello' },
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          ],
          'turn-direct-1',
          located.session.turnSeq,
        ),
      ).rejects.toMatchObject({
        code: 'image_unsupported',
        message: expect.stringContaining('does not support image input'),
      })
      await expect(
        located.bridge.runPrompt(located.session, [], 'turn-direct-empty', located.session.turnSeq),
      ).rejects.toMatchObject({
        code: 'empty_prompt',
      })
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('BridgeManager.prompt supports ContentBlock[] directly and rejects when unsupported', async () => {
    const gmNo = new BridgeManager([noImageDef], imageHub, 500, join(imageRoot, 'gm-no-agents.json'))
    const gmYes = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'gm-yes-agents.json'))
    try {
      const sNo = await gmNo.startSession('noimage', undefined)
      await expect(
        gmNo.prompt(sNo.sessionId, [
          { type: 'text', text: 'describe' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ]),
      ).rejects.toMatchObject({
        code: 'image_unsupported',
        message: expect.stringContaining('does not support image input'),
      })

      const sYes = await gmYes.startSession('hasimage', undefined)
      const res = await gmYes.prompt(sYes.sessionId, [
        { type: 'text', text: 'describe' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ])
      expect(res.turnId).toBeDefined()
      await settleTranscript(gmYes, sYes.sessionId)
      const transcript = await dispatchRpc(gmYes, 'transcript/get', { sessionId: sYes.sessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
      await expect(gmYes.prompt(sYes.sessionId, [])).rejects.toMatchObject({
        code: 'empty_prompt',
      })
    } finally {
      await gmNo.shutdownAll()
      await gmYes.shutdownAll()
    }
  }, 30_000)

  it('resolves relative image file path against conversation workspace root', async () => {
    const workDir = mkdtempSync(join(imageRoot, 'work-'))
    writeFileSync(join(workDir, 'chart.png'), 'png-bytes-data')
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'rel-agents.json'))
    try {
      gm.setSessionWorkspaceResolver(sId => (sId === 'dsh-work-sess' ? { workspaceRoot: workDir } : undefined))
      gm.bindChatAgent('dsh-work-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-work-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'check chart' },
              { type: 'image', path: './chart.png' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }
      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish).toBeDefined()
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-work-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('resolves attachments through an attachment resolver class with prototype methods', async () => {
    class MockAttachmentService {
      getAttachment(id: string) {
        if (id === 'service-att-1') {
          return { data: 'data:image/png;base64,cHJvdG9pbWFnZQ==' }
        }
        return undefined
      }
    }
    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'proto-agents.json'))
    try {
      gm.setAttachmentResolver(new MockAttachmentService())
      gm.bindChatAgent('dsh-proto-sess', 'hasimage')
      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-proto-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe proto image' },
              { type: 'image', attachmentId: 'service-att-1' },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }
      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-proto-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('resolves image attachment through a LocalAttachmentStore service requiring this.root and async readImage', async () => {
    const hash = 'ab' + 'd'.repeat(62)
    const objectsDir = join(imageRoot, 'dsh-objects', 'objects', 'ab')
    mkdirSync(objectsDir, { recursive: true })
    writeFileSync(join(objectsDir, hash), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))

    class RealisticAttachmentStore {
      root = join(imageRoot, 'dsh-objects')

      imageHostPath(ref: { attachmentId?: string }) {
        if (!this || this.root !== join(imageRoot, 'dsh-objects')) {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref?.attachmentId))
        if (!match) throw new Error('INVALID_ATTACHMENT_REF')
        return join(this.root, 'objects', match[1].slice(0, 2), match[1])
      }

      async readImage(ref: { attachmentId?: string }) {
        if (!this || this.root !== join(imageRoot, 'dsh-objects')) {
          throw new TypeError("Cannot read properties of undefined (reading 'root')")
        }
        throw new Error('ATTACHMENT_NOT_FOUND')
      }
    }

    const gm = new BridgeManager([imageDef], imageHub, 500, join(imageRoot, 'realstore-agents.json'))
    try {
      gm.setAttachmentResolver(new RealisticAttachmentStore())
      gm.bindChatAgent('dsh-realstore-sess', 'hasimage')

      const chunks: StreamChunk[] = []
      for await (const chunk of gm.streamPrompt({
        model: 'hasimage',
        sessionId: 'dsh-realstore-sess',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe this attached screenshot' },
              {
                type: 'image',
                attachment: {
                  attachmentId: `sha256:${hash}`,
                  mediaType: 'image/png',
                },
              },
            ],
          },
        ],
      } as never)) {
        chunks.push(chunk)
      }

      const finish = chunks.find(c => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
      expect(finish?.reason.kind).toBe('stop')

      const acpSessionId = gm.chatSessions('dsh-realstore-sess')[0]?.sessionId
      expect(acpSessionId).toBeDefined()
      await settleTranscript(gm, acpSessionId!)
      const transcript = await dispatchRpc(gm, 'transcript/get', { sessionId: acpSessionId })
      expect(transcript.ok).toBe(true)
      const echoedText = ((transcript as { value: { entries: Array<{ update: Record<string, unknown> }> } }).value.entries)
        .filter(entry => entry.update.sessionUpdate === 'agent_message_chunk')
        .map(entry => String((entry.update.content as { text?: string }).text ?? ''))
        .join('')
      expect(echoedText).toContain('images=1')
    } finally {
      await gm.shutdownAll()
    }
  }, 30_000)

  it('handles concurrent mixed image and text requests across different agents without interference', async () => {
    const gm = new BridgeManager([noImageDef, imageDef], imageHub, 500, join(imageRoot, 'concurrent-agents.json'))
    try {
      gm.bindChatAgent('dsh-conc-img-yes', 'hasimage')
      gm.bindChatAgent('dsh-conc-img-no', 'noimage')
      gm.bindChatAgent('dsh-conc-txt-no', 'noimage')

      const runTurn = async (sessionId: string, model: string, content: Array<{ type: string; [k: string]: unknown }>) => {
        const chunks: StreamChunk[] = []
        for await (const chunk of gm.streamPrompt({
          model,
          sessionId,
          messages: [{ role: 'user', content }],
        } as never)) {
          chunks.push(chunk)
        }
        return chunks
      }

      const [resImgYes, resImgNo, resTxtNo] = await Promise.all([
        runTurn('dsh-conc-img-yes', 'hasimage', [
          { type: 'text', text: 'image prompt' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ]),
        runTurn('dsh-conc-img-no', 'noimage', [
          { type: 'text', text: 'unsupported image prompt' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ]),
        runTurn('dsh-conc-txt-no', 'noimage', [
          { type: 'text', text: 'plain text only' },
        ]),
      ])

      expect(resImgYes.find(c => c.type === 'finish')?.reason.kind).toBe('stop')
      expect(resImgNo.find(c => c.type === 'finish')?.reason).toMatchObject({
        kind: 'error',
        failure: { code: 'image_unsupported' },
      })
      expect(resTxtNo.find(c => c.type === 'finish')?.reason.kind).toBe('stop')
    } finally {
      await gm.shutdownAll()
    }
  }, 45_000)
})
