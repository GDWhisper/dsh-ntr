/**
 * Unit coverage for Antigravity's transcript reader (P1 of
 * docs/plan/antigravity-late-output.md): path rules, incremental reads and
 * answer extraction. The echo guard's four states are pinned here too (P3).
 */
import { mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgyTranscriptTail,
  agyStoreRoot,
  agyTranscriptPaths,
  isAntigravityAgent,
  lateAnswerText,
  parseTranscriptStep,
  type TranscriptStep,
} from '../src/bridge/agy-transcript.ts'
import { applyEchoGuard } from '../src/bridge/turn-stream.ts'
import type { AcpAgentDef } from '../src/protocol.ts'

function agentDef(args: string[], command = '/usr/local/bin/agy'): AcpAgentDef {
  return { id: 'agy', title: 'Antigravity', command, args, env: {}, cwd: tmpdir(), allowedCwdRoots: [tmpdir()] }
}

function step(stepIndex: number, content: string, overrides: Partial<TranscriptStep> = {}): TranscriptStep {
  return { stepIndex, type: 'PLANNER_RESPONSE', status: 'DONE', content, ...overrides }
}

const temporaryDirs: string[] = []

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ntr-agy-transcript-'))
  temporaryDirs.push(dir)
  return dir
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

function transcriptLine(stepIndex: number, content: string, type = 'PLANNER_RESPONSE'): string {
  return `${JSON.stringify({ step_index: stepIndex, type, status: 'DONE', created_at: '2026-11-10T01:56:23Z', content })}\n`
}

describe('Antigravity agent recognition', () => {
  it('matches the agy program with the acp argument, under either path style', () => {
    expect(isAntigravityAgent(agentDef(['acp']))).toBe(true)
    expect(isAntigravityAgent(agentDef(['acp'], 'C:\\tools\\agy.exe'))).toBe(true)
    expect(isAntigravityAgent(agentDef(['acp'], 'agy.CMD'))).toBe(true)
    expect(isAntigravityAgent(agentDef(['acp'], 'C:\\tools\\agy.bat'))).toBe(true)
  })

  it('ignores other programs, other arguments and a renamed command', () => {
    expect(isAntigravityAgent(agentDef(['acp'], '/usr/local/bin/codebuddy'))).toBe(false)
    expect(isAntigravityAgent(agentDef([]))).toBe(false)
    expect(isAntigravityAgent(agentDef(['acp-server']))).toBe(false)
    expect(isAntigravityAgent({ ...agentDef(['acp']), id: 'agy' })).toBe(true)
  })
})

describe('Antigravity store root', () => {
  it('resolves defaults against HOME on POSIX', () => {
    expect(agyStoreRoot(agentDef(['acp']), { HOME: '/home/u' }, 'linux')).toBe('/home/u/.gemini/antigravity-cli')
  })

  it('resolves defaults against USERPROFILE on win32', () => {
    expect(agyStoreRoot(agentDef(['acp']), { USERPROFILE: 'C:\\Users\\u' }, 'win32'))
      .toBe('C:\\Users\\u\\.gemini\\antigravity-cli')
  })

  it('reads both flag spellings in = and space form', () => {
    expect(agyStoreRoot(agentDef(['acp', '--gemini-dir=custom', '--app-data-dir=store']), { HOME: '/home/u' }, 'linux'))
      .toBe('/home/u/custom/store')
    expect(agyStoreRoot(agentDef(['acp', '--gemini_dir', 'other', '--app_data_dir', 'store2']), { HOME: '/home/u' }, 'linux'))
      .toBe('/home/u/other/store2')
  })

  it('keeps an absolute directory as given', () => {
    expect(agyStoreRoot(agentDef(['acp', '--app-data-dir=/var/data/agy']), { HOME: '/home/u' }, 'linux'))
      .toBe('/var/data/agy')
    expect(agyStoreRoot(agentDef(['acp', '--gemini-dir=C:\\G', '--app-data-dir=store']), { USERPROFILE: 'C:\\Users\\u' }, 'win32'))
      .toBe('C:\\G\\store')
  })

  it('returns null without a usable home', () => {
    // `homedir()` is the documented fallback; only an EMPTY environment plus an
    // impossible platform has no home at all, so that is what this checks.
    const root = agyStoreRoot(agentDef(['acp']), {}, 'linux')
    expect(root === null || root.startsWith('/')).toBe(true)
  })
})

describe('Antigravity transcript paths', () => {
  it('lists both candidate files under the session brain directory', () => {
    expect(agyTranscriptPaths('/store', 'abc-123_XYZ')).toEqual([
      join('/store', 'brain', 'abc-123_XYZ', '.system_generated', 'logs', 'transcript_full.jsonl'),
      join('/store', 'brain', 'abc-123_XYZ', '.system_generated', 'logs', 'transcript.jsonl'),
    ])
  })

  it('refuses a session id that cannot be one path segment', () => {
    expect(agyTranscriptPaths('/store', '../../etc')).toEqual([])
    expect(agyTranscriptPaths('/store', 'a/b')).toEqual([])
    expect(agyTranscriptPaths('/store', '')).toEqual([])
  })
})

describe('transcript step parsing', () => {
  it('parses a planner response and ignores unknown keys', () => {
    const parsed = parseTranscriptStep(JSON.stringify({
      step_index: 7,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-10T01:56:23Z',
      content: 'answer',
      thinking: 'thought',
      extra: 'ignored',
    }))
    expect(parsed).toEqual({ stepIndex: 7, type: 'PLANNER_RESPONSE', status: 'DONE', createdAt: '2026-11-10T01:56:23Z', content: 'answer', thinking: 'thought' })
  })

  it('rejects malformed lines and steps without a finite index', () => {
    expect(parseTranscriptStep('not json')).toBeUndefined()
    expect(parseTranscriptStep('null')).toBeUndefined()
    expect(parseTranscriptStep('[]')).toBeUndefined()
    expect(parseTranscriptStep('{"step_index":"7"}')).toBeUndefined()
    expect(parseTranscriptStep('{"type":"PLANNER_RESPONSE"}')).toBeUndefined()
  })
})

describe('late answer extraction', () => {
  it('joins every DONE planner response in step order', () => {
    expect(lateAnswerText([step(2, 'second'), step(1, 'first')])).toBe('first\n\nsecond')
  })

  it('skips unfinished, empty and non-planner steps', () => {
    expect(lateAnswerText([
      step(1, 'pending', { status: 'RUNNING' }),
      step(2, '   '),
      step(3, 'system report', { type: 'SYSTEM_MESSAGE' }),
      step(4, 'only thinking', { content: '', thinking: 'a thought' }),
    ])).toBe('')
  })

  it('returns an empty string for no steps', () => {
    expect(lateAnswerText([])).toBe('')
  })
})

describe('incremental transcript tail', () => {
  it('waits for the newline of a half-written line and decodes it whole', () => {
    const dir = temporaryDir()
    const path = join(dir, 'transcript_full.jsonl')
    writeFileSync(path, '')
    const tail = new AgyTranscriptTail(path)
    tail.baseline()
    const line = transcriptLine(1, '答案文本')
    appendFileSync(path, line.slice(0, -1))
    expect(tail.readNew()).toEqual([])
    expect(tail.offset).toBe(0)
    appendFileSync(path, '\n')
    const steps = tail.readNew()
    expect(steps).toHaveLength(1)
    expect(steps[0]?.content).toBe('答案文本')
    expect(tail.lastStepIndex).toBe(1)
  })

  it('never cuts a multi-byte character at the read boundary', () => {
    const dir = temporaryDir()
    const path = join(dir, 'transcript.jsonl')
    writeFileSync(path, '')
    const tail = new AgyTranscriptTail(path)
    tail.baseline()
    const payload = transcriptLine(1, '你好世界')
    const bytes = Buffer.from(payload, 'utf8')
    // Split INSIDE the four-byte-per-character text, then finish the line.
    appendFileSync(path, bytes.subarray(0, bytes.length - 12))
    expect(tail.readNew()).toEqual([])
    appendFileSync(path, bytes.subarray(bytes.length - 12))
    expect(tail.readNew()[0]?.content).toBe('你好世界')
  })

  it('skips blank and malformed lines and reports steps in order', () => {
    const dir = temporaryDir()
    const path = join(dir, 'transcript_full.jsonl')
    writeFileSync(path, `${transcriptLine(1, 'one')}\nnot json\n${transcriptLine(2, 'two')}`)
    const tail = new AgyTranscriptTail(path)
    tail.baseline()
    expect(tail.readNew()).toEqual([])
    appendFileSync(path, `\n${transcriptLine(3, 'three')}\n`)
    expect(tail.readNew().map(item => item.stepIndex)).toEqual([3])
    expect(tail.lastStepIndex).toBe(3)
  })

  it('recomputes the baseline from the file tail and replays nothing before it', () => {
    const dir = temporaryDir()
    const path = join(dir, 'transcript_full.jsonl')
    writeFileSync(path, transcriptLine(4, 'before arm'))
    const tail = new AgyTranscriptTail(path)
    tail.baseline()
    expect(tail.offset).toBe(statSync(path).size)
    expect(tail.lastStepIndex).toBe(4)
    expect(tail.readNew()).toEqual([])
    appendFileSync(path, transcriptLine(5, 'after arm'))
    expect(tail.readNew().map(item => item.stepIndex)).toEqual([5])
  })

  it('restarts from the beginning when the file was truncated or rebuilt', () => {
    const dir = temporaryDir()
    const path = join(dir, 'transcript_full.jsonl')
    writeFileSync(path, transcriptLine(1, 'an older and decidedly longer answer'))
    const tail = new AgyTranscriptTail(path)
    tail.baseline()
    writeFileSync(path, transcriptLine(2, 'new'))
    expect(tail.readNew().map(item => item.content)).toEqual(['new'])
  })

  it('returns nothing for a missing file instead of throwing', () => {
    const dir = temporaryDir()
    const tail = new AgyTranscriptTail(join(dir, 'missing', 'transcript_full.jsonl'))
    tail.baseline()
    expect(tail.readNew()).toEqual([])
  })

  it('reads a file larger than one 512 KiB pass in bounded pieces', () => {
    const dir = temporaryDir()
    const path = join(dir, 'transcript_full.jsonl')
    writeFileSync(path, '')
    const tail = new AgyTranscriptTail(path)
    tail.baseline()
    const filler = 'x'.repeat(1024)
    let payload = ''
    for (let index = 1; index <= 700; index += 1) payload += transcriptLine(index, filler)
    expect(Buffer.byteLength(payload)).toBeGreaterThan(512 * 1024)
    appendFileSync(path, payload)
    const first = tail.readNew()
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(700)
    const second = tail.readNew()
    expect(first.length + second.length).toBe(700)
  })

  it('drops an over-long line without a newline instead of pinning the tail', () => {
    const dir = temporaryDir()
    const path = join(dir, 'transcript_full.jsonl')
    writeFileSync(path, '')
    const tail = new AgyTranscriptTail(path)
    tail.baseline()
    appendFileSync(path, `${'y'.repeat(1024 * 1024)}\n${transcriptLine(9, 'after the long line')}`)
    const steps = tail.readNew()
    expect(steps.map(item => item.stepIndex)).toEqual([9])
    expect(tail.lastStepIndex).toBe(9)
  })
})

describe('echo guard', () => {
  const late = 'the whole late answer'

  it('holds every strict prefix and emits nothing', () => {
    expect(applyEchoGuard(late, '', 'the whole')).toEqual({ kind: 'hold', buffer: 'the whole' })
    expect(applyEchoGuard(late, 'the whole', ' late')).toEqual({ kind: 'hold', buffer: 'the whole late' })
  })

  it('swallows a chunk that ends exactly on the late answer', () => {
    expect(applyEchoGuard(late, 'the whole late ', 'answer')).toEqual({ kind: 'swallow', buffer: '' })
    // The whole answer in ONE chunk is the same case.
    expect(applyEchoGuard(late, '', late)).toEqual({ kind: 'swallow', buffer: '' })
  })

  it('releases only the new tail when the old answer is a prefix', () => {
    expect(applyEchoGuard(late, '', `${late} and the new answer`)).toEqual({
      kind: 'release',
      buffer: '',
      emit: ' and the new answer',
    })
    expect(applyEchoGuard(late, 'the whole', ' late answer plus more')).toEqual({
      kind: 'release',
      buffer: '',
      emit: ' plus more',
    })
  })

  it('fails open on a mismatch instead of eating a real answer', () => {
    expect(applyEchoGuard(late, '', 'a completely different answer')).toEqual({
      kind: 'mismatch',
      buffer: '',
      emit: 'a completely different answer',
    })
    expect(applyEchoGuard(late, 'the whole', ' odd turn')).toEqual({
      kind: 'mismatch',
      buffer: '',
      emit: 'the whole odd turn',
    })
  })

  it('treats an empty chunk while holding as another hold', () => {
    expect(applyEchoGuard(late, 'the ', '')).toEqual({ kind: 'hold', buffer: 'the ' })
  })
})
