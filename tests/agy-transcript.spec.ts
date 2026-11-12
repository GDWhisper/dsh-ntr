/**
 * Unit coverage for Antigravity's transcript reader (P1 of
 * docs/plan/antigravity-late-output.md): path rules, incremental reads and
 * answer extraction. The echo guard's four states are pinned here too (P3).
 */
import { mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgyTranscriptTail,
  agyChildProgress,
  agyStoreRoot,
  agyTranscriptPaths,
  foldAgyOpenToolSteps,
  isAgyChildReport,
  isAntigravityAgent,
  lateAnswerText,
  parseAgyConversationId,
  parseTranscriptStep,
  type TranscriptStep,
} from '../src/bridge/agy-transcript.ts'
import { applyEchoGuard } from '../src/bridge/turn-stream.ts'
import { validateConfig } from '../src/impl.ts'
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

  it('never treats the NEXT flag as a missing flag value', () => {
    // `--gemini-dir --app-data-dir x`: the token after the first flag is
    // another option, so the gemini directory falls back to its default.
    expect(agyStoreRoot(agentDef(['acp', '--gemini-dir', '--app-data-dir', 'x']), { HOME: '/home/u' }, 'linux'))
      .toBe('/home/u/.gemini/x')
    // Empty values (both spellings) are "not given" too.
    expect(agyStoreRoot(agentDef(['acp', '--gemini-dir=', '--app-data-dir=', '--gemini_dir', '']), { HOME: '/home/u' }, 'linux'))
      .toBe('/home/u/.gemini/antigravity-cli')
    expect(agyStoreRoot(agentDef(['acp', '--app-data-dir', '', '--gemini-dir', 'g']), { HOME: '/home/u' }, 'linux'))
      .toBe('/home/u/g/antigravity-cli')
  })

  it('keeps an absolute directory as given', () => {
    expect(agyStoreRoot(agentDef(['acp', '--app-data-dir=/var/data/agy']), { HOME: '/home/u' }, 'linux'))
      .toBe('/var/data/agy')
    expect(agyStoreRoot(agentDef(['acp', '--gemini-dir=C:\\G', '--app-data-dir=store']), { USERPROFILE: 'C:\\Users\\u' }, 'win32'))
      .toBe('C:\\G\\store')
  })

  it('falls back to os.homedir() when the environment has no home', () => {
    // An EMPTY HOME is "unset": the documented fallback is `os.homedir()`.
    const root = agyStoreRoot(agentDef(['acp']), { HOME: '' }, 'linux')
    expect(root?.startsWith(homedir())).toBe(true)
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
  it('keeps only the LAST finished planner response', () => {
    // A background run announces only its final answer; earlier intermediate
    // replies stay in the transcript but must never be concatenated.
    expect(lateAnswerText([step(2, 'second'), step(1, 'first')])).toBe('second')
    expect(lateAnswerText([step(1, 'first'), step(2, 'second'), step(3, 'third')])).toBe('third')
    // An unfinished later step does not displace an earlier finished one.
    expect(lateAnswerText([step(1, 'first'), step(2, 'pending', { status: 'RUNNING' })])).toBe('first')
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
    // A FULL 512 KiB window without a newline is discarded AT ONCE: the offset
    // moves past it, so the next tick never re-reads the same bytes.
    expect(tail.readNew()).toEqual([])
    expect(tail.offset).toBe(512 * 1024)
    const steps: TranscriptStep[] = []
    for (let pass = 0; pass < 4 && steps.length === 0; pass += 1) steps.push(...tail.readNew())
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

describe('Antigravity late-output switch', () => {
  it('accepts the agyLateOutput switch as an optional boolean', () => {
    // Absent: the tuning default (on) stays in force; the config object must
    // not carry `undefined`, or the host entry would overwrite the default.
    expect(validateConfig({ agents: [] })).not.toHaveProperty('agyLateOutput')
    expect(validateConfig({ agents: [], agyLateOutput: false }).agyLateOutput).toBe(false)
    expect(validateConfig({ agents: [], agyLateOutput: true }).agyLateOutput).toBe(true)
    expect(() => validateConfig({ agents: [], agyLateOutput: 'yes' })).toThrow(/agyLateOutput/)
    expect(() => validateConfig({ agents: [], agyLateOutput: 0 })).toThrow(/agyLateOutput/)
  })

  it('accepts the two watch windows as optional non-negative integers', () => {
    // Absent keys stay absent so the host entry keeps the tuning defaults.
    const absent = validateConfig({ agents: [] })
    expect(absent).not.toHaveProperty('agyLateOutputMaxMs')
    expect(absent).not.toHaveProperty('agyLateOutputCeilingMs')
    expect(validateConfig({ agents: [], agyLateOutputMaxMs: 0 }).agyLateOutputMaxMs).toBe(0)
    expect(validateConfig({ agents: [], agyLateOutputMaxMs: 1_800_000 }).agyLateOutputMaxMs).toBe(1_800_000)
    expect(validateConfig({ agents: [], agyLateOutputCeilingMs: 0 }).agyLateOutputCeilingMs).toBe(0)
    expect(validateConfig({ agents: [], agyLateOutputCeilingMs: 60_000 }).agyLateOutputCeilingMs).toBe(60_000)
    expect(() => validateConfig({ agents: [], agyLateOutputMaxMs: -1 })).toThrow(/agyLateOutputMaxMs/)
    expect(() => validateConfig({ agents: [], agyLateOutputMaxMs: 1.5 })).toThrow(/agyLateOutputMaxMs/)
    expect(() => validateConfig({ agents: [], agyLateOutputMaxMs: 'x' })).toThrow(/agyLateOutputMaxMs/)
    expect(() => validateConfig({ agents: [], agyLateOutputCeilingMs: -1 })).toThrow(/agyLateOutputCeilingMs/)
    expect(() => validateConfig({ agents: [], agyLateOutputCeilingMs: 86_400_001 })).toThrow(/agyLateOutputCeilingMs/)
  })
})

describe('dispatch result conversationId parsing', () => {
  /** The measured `invoke_subagent` result text (task-1 brief evidence). */
  function resultText(childId: string): string {
    return `Created the following subagent:\n${JSON.stringify({
      conversationId: childId,
      logAbsoluteUri: `file:///home/u/.gemini/antigravity-cli/brain/${childId}/.system_generated/logs/transcript.jsonl`,
      workspaceUris: ['file:///home/u/project'],
    })}`
  }

  it('reads the conversationId out of the creation result', () => {
    expect(parseAgyConversationId(resultText('agy-child-42'))).toBe('agy-child-42')
  })

  it('reads a pretty-printed payload behind several prefix lines', () => {
    const text = `Created the following subagent:\nSome extra prose line.\n${JSON.stringify({ conversationId: 'child_x-9', workspaceUris: [] }, null, 2)}`
    expect(parseAgyConversationId(text)).toBe('child_x-9')
  })

  it('returns undefined when the field is missing or not a usable id', () => {
    expect(parseAgyConversationId('Created the following subagent:\n{"logAbsoluteUri":"file:///x"}')).toBeUndefined()
    expect(parseAgyConversationId('{"conversationId":123}')).toBeUndefined()
    expect(parseAgyConversationId('{"conversationId":""}')).toBeUndefined()
    // The id names a brain directory: separators / traversal are not ids.
    expect(parseAgyConversationId('{"conversationId":"../escape"}')).toBeUndefined()
    expect(parseAgyConversationId('{"conversationId":"a/b"}')).toBeUndefined()
  })

  it('fails open on bad JSON, missing braces and empty text — never throws', () => {
    expect(parseAgyConversationId('Created the following subagent:\n{conversationId: broken')).toBeUndefined()
    expect(parseAgyConversationId('no json here at all')).toBeUndefined()
    expect(parseAgyConversationId('')).toBeUndefined()
    expect(parseAgyConversationId('{')).toBeUndefined()
    expect(parseAgyConversationId('{"conversationId":"ok"} trailing }')).toBeUndefined()
  })

  it('stays bounded on pathological input', () => {
    // A prefix longer than the scan window pushes the payload out of reach:
    // the answer is undefined, not an unbounded scan or a throw.
    const huge = `${'x'.repeat(128 * 1024)}\n${resultText('late-child')}`
    expect(parseAgyConversationId(huge)).toBeUndefined()
    expect(parseAgyConversationId(resultText('ok-child').padEnd(200_000, ' '))).toBe('ok-child')
  })
})

describe('subagent transcript tool-step parsing', () => {
  it('counts the tool_calls entries of a step', () => {
    const line = JSON.stringify({
      step_index: 4,
      type: 'GENERIC',
      status: 'RUNNING',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }, { name: 'read_file', args: {} }],
    })
    expect(parseTranscriptStep(line)?.toolCallCount).toBe(2)
  })

  it('leaves the count absent when there are no usable tool calls', () => {
    const base = { step_index: 1, type: 'GENERIC', status: 'DONE', content: 'x' }
    expect(parseTranscriptStep(JSON.stringify(base))?.toolCallCount).toBeUndefined()
    expect(parseTranscriptStep(JSON.stringify({ ...base, tool_calls: [] }))?.toolCallCount).toBeUndefined()
    expect(parseTranscriptStep(JSON.stringify({ ...base, tool_calls: 'run_command' }))?.toolCallCount).toBeUndefined()
    expect(parseTranscriptStep(JSON.stringify({ ...base, tool_calls: null }))?.toolCallCount).toBeUndefined()
  })
})

describe('subagent completion: parent report signal', () => {
  /** The measured parent-transcript report shape (task-2 brief evidence). */
  function reportStep(childId: string, overrides: Partial<TranscriptStep> = {}): TranscriptStep {
    return {
      stepIndex: 9,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `[Message] timestamp=2026-11-10T01:56:23Z sender=${childId} priority=MESSAGE_PRIORITY_HIGH content=License migration complete.`,
      ...overrides,
    }
  }

  it('matches a SYSTEM_MESSAGE whose sender token names the child', () => {
    expect(isAgyChildReport(reportStep('child-42'), 'child-42')).toBe(true)
  })

  it('rejects another child, a prefix and a missing sender', () => {
    expect(isAgyChildReport(reportStep('child-42'), 'child-43')).toBe(false)
    // A prefix of the id is not the id: the token must match whole.
    expect(isAgyChildReport(reportStep('child-42'), 'child-4')).toBe(false)
    expect(isAgyChildReport(reportStep('child-42'), '')).toBe(false)
    expect(isAgyChildReport({ ...reportStep('child-42'), content: '[Message] no sender here' }, 'child-42')).toBe(false)
  })

  it('rejects non-SYSTEM_MESSAGE steps even when they quote the sender', () => {
    // The child's own "Message sent to …" GENERIC step is NOT a signal.
    expect(isAgyChildReport(reportStep('child-42', { type: 'GENERIC' }), 'child-42')).toBe(false)
    expect(isAgyChildReport(reportStep('child-42', { type: 'PLANNER_RESPONSE' }), 'child-42')).toBe(false)
  })
})

describe('subagent completion: child DONE fallback', () => {
  function planner(stepIndex: number, status: string, content: string): TranscriptStep {
    return { stepIndex, type: 'PLANNER_RESPONSE', status, content }
  }

  it('fires when the last planner response is DONE with content', () => {
    const steps = [planner(1, 'DONE', 'first answer'), planner(2, 'DONE', 'final answer')]
    const outcome = agyChildProgress(steps, undefined)
    expect(outcome.done).toBe(true)
    expect(outcome.lastPlanner?.stepIndex).toBe(2)
  })

  it('does not fire while the last planner response is RUNNING or empty', () => {
    expect(agyChildProgress([planner(1, 'RUNNING', 'partial')], undefined).done).toBe(false)
    expect(agyChildProgress([planner(1, 'DONE', '   ')], undefined).done).toBe(false)
    expect(agyChildProgress([], undefined).done).toBe(false)
  })

  it('carries the newest planner response across batches', () => {
    const first = agyChildProgress([planner(1, 'DONE', 'done once')], undefined)
    expect(first.done).toBe(true)
    // A later batch with only tool steps keeps the last planner response.
    const toolBatch = agyChildProgress([{ stepIndex: 2, type: 'GENERIC', status: 'DONE', content: '' }], first.lastPlanner)
    expect(toolBatch.lastPlanner?.stepIndex).toBe(1)
    // A NEWER running response supersedes the old DONE: the child works again.
    const resumed = agyChildProgress([planner(3, 'RUNNING', 'more work')], toolBatch.lastPlanner)
    expect(resumed.done).toBe(false)
    expect(resumed.lastPlanner?.stepIndex).toBe(3)
    // An out-of-order older line never replaces the newest one.
    const stale = agyChildProgress([planner(0, 'DONE', 'ancient')], resumed.lastPlanner)
    expect(stale.lastPlanner?.stepIndex).toBe(3)
  })

  it('treats ERROR steps as runtime tool failures, never a terminal failure', () => {
    // Measured: a child with six ERROR steps still finished DONE. Nothing here
    // may derive `failed` from an ERROR step (the real shape is unmeasured).
    const errors: TranscriptStep[] = [
      { stepIndex: 1, type: 'GENERIC', status: 'ERROR', content: '', toolCallCount: 1 },
      { stepIndex: 2, type: 'GENERIC', status: 'ERROR', content: 'command failed' },
    ]
    const outcome = agyChildProgress(errors, undefined)
    expect(outcome.done).toBe(false)
    expect(outcome.lastPlanner).toBeUndefined()
    const finished = agyChildProgress([...errors, planner(3, 'DONE', 'recovered')], undefined)
    expect(finished.done).toBe(true)
  })
})

describe('subagent open tool-step fold', () => {
  function toolStep(stepIndex: number, status: string): TranscriptStep {
    return { stepIndex, type: 'GENERIC', status, content: '', toolCallCount: 1 }
  }

  it('opens a RUNNING tool step and closes it when the child moves on', () => {
    const open = new Map<string, number>()
    foldAgyOpenToolSteps(open, [toolStep(2, 'RUNNING')], 1_000)
    expect([...open.entries()]).toEqual([['2', 1_000]])
    // ANY newer step supersedes the running tool (append-only transcript).
    foldAgyOpenToolSteps(open, [{ stepIndex: 3, type: 'GENERIC', status: 'DONE', content: 'result' }], 2_000)
    expect(open.size).toBe(0)
  })

  it('closes a re-sent index that reports DONE or ERROR', () => {
    const open = new Map<string, number>()
    foldAgyOpenToolSteps(open, [toolStep(2, 'RUNNING')], 1_000)
    foldAgyOpenToolSteps(open, [toolStep(2, 'ERROR')], 2_000)
    expect(open.size).toBe(0)
  })

  it('never opens a step without tool calls, whatever its status', () => {
    const open = new Map<string, number>()
    foldAgyOpenToolSteps(open, [{ stepIndex: 1, type: 'PLANNER_RESPONSE', status: 'RUNNING', content: 'thinking' }], 1_000)
    expect(open.size).toBe(0)
  })

  it('keeps the newest open step when a batch opens several', () => {
    const open = new Map<string, number>()
    foldAgyOpenToolSteps(open, [toolStep(2, 'RUNNING'), toolStep(3, 'RUNNING')], 1_000)
    expect([...open.keys()]).toEqual(['3'])
  })
})
