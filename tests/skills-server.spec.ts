/**
 * The `dsh-skills` MCP server: stdio protocol loop, version negotiation, lazy
 * (zero skill-directory read) handshake, the listing/reading contract, and the
 * path-security matrix — including EQUIVALENCE with the host's own
 * `isAbsolutePath` / `isUnderPath` and frontmatter parser (constraint 24: the
 * server carries a hand copy, and this file is what keeps the copy honest).
 *
 * Spec: docs/plan/dsh-skills-mcp.md §8 and §11.2–11.6.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isAbsolutePath, isUnderPath, parseSkillFrontmatter } from '../src/impl.ts'
import * as server from '../mcp/skills-server.mjs'

const SERVER = fileURLToPath(new URL('../mcp/skills-server.mjs', import.meta.url))

// ---- fixtures ----

const tempDirs: string[] = []

/** A temp tree laid out as `root/skills/<skill>` plus a plugin state dir beside it. */
function tempTree(): { dir: string; skills: string; stateDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  tempDirs.push(dir)
  const skills = join(dir, 'skills')
  const stateDir = join(dir, 'dsh-ntr')
  mkdirSync(skills, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return { dir, skills, stateDir }
}

function writeSkill(skills: string, name: string, content: string, file = 'SKILL.md'): string {
  const target = join(skills, name, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

function frontmatter(description: string, body = 'body\n'): string {
  return `---\ndescription: ${description}\n---\n${body}`
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---- the stdio harness ----

type Frame = Record<string, any>

interface ServerSession {
  readonly frames: Frame[]
  readonly malformed: string[]
  request(method: string, params?: unknown): Promise<Frame>
  notify(method: string, params?: unknown): void
  raw(line: string): void
  stderr(): string
  close(): Promise<number | null>
}

/**
 * A real `process.execPath` child speaking newline-delimited JSON-RPC. Every
 * stdout line is JSON.parse'd on arrival: a frame that is not a single
 * self-contained JSON message shows up in `malformed` instead of being hidden.
 */
function startServer(extraEnv: Record<string, string>): ServerSession {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe',
  })
  const frames: Frame[] = []
  const malformed: string[] = []
  const pending = new Map<number, (frame: Frame) => void>()
  const watchers = new Set<() => void>()
  let stderrText = ''
  let buffer = ''
  let nextId = 1

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderrText += chunk })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      let frame: Frame
      try {
        frame = JSON.parse(line) as Frame
      } catch {
        malformed.push(line)
        continue
      }
      frames.push(frame)
      if (typeof frame.id === 'number') {
        const resolvePending = pending.get(frame.id)
        if (resolvePending !== undefined) {
          pending.delete(frame.id)
          resolvePending(frame)
        }
      }
      for (const watcher of [...watchers]) watcher()
    }
  })

  const session: ServerSession = {
    frames,
    malformed,
    request(method, params) {
      const id = nextId
      nextId += 1
      const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
      child.stdin.write(`${JSON.stringify(message)}\n`)
      return new Promise<Frame>((resolveFrame, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000)
        pending.set(id, frame => {
          clearTimeout(timer)
          resolveFrame(frame)
        })
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`)
    },
    raw(line) {
      child.stdin.write(`${line}\n`)
    },
    stderr: () => stderrText,
    close: () => new Promise<number | null>(resolveExit => {
      if (child.exitCode !== null) {
        resolveExit(child.exitCode)
        return
      }
      child.once('exit', code => resolveExit(code))
      child.stdin.end()
    }),
  }
  return session
}

/** Wait until `frames` grows past `since` (used for frames that carry no request id). */
function nextFrame(session: ServerSession, since: number): Promise<Frame> {
  return new Promise<Frame>((resolveFrame, reject) => {
    const deadline = Date.now() + 10_000
    const tick = (): void => {
      if (session.frames.length > since) {
        resolveFrame(session.frames[since])
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('timeout waiting for a frame'))
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

/** Text of one tool result, all text blocks joined. */
function resultText(frame: Frame): string {
  return (frame.result.content as Array<{ type: string; text: string }>).map(block => block.text).join('')
}

function listEntries(frame: Frame): Array<{ name: string; description: string; path: string }> {
  return JSON.parse((frame.result.content[0] as { text: string }).text) as Array<{ name: string; description: string; path: string }>
}

// ---- host-parity intent ----

describe('dsh-skills path primitives are equivalent to the host implementation', () => {
  it('answers isAbsolutePath identically on every spelling this plugin can see', () => {
    const samples = [
      '/work', '/', '', 'relative', '.\\x', '\\x', '~/.dsh', 'a/b',
      'C:\\work', 'C:/work', 'C:relative', 'C:', 'd:', 'D:\\',
      '\\\\srv\\share', '\\\\srv', '\\\\.\\pipe\\x', '//srv/share', '//srv',
      '\\\\?\\C:\\work', '//?/C:/work', '\\\\?\\UNC\\srv\\share\\x',
    ]
    for (const sample of samples) {
      expect({ sample, absolute: server.isAbsolutePath(sample) }).toEqual({ sample, absolute: isAbsolutePath(sample) })
    }
  })

  it('answers isUnderPath identically, including the sibling-prefix and root cases', () => {
    const pairs: Array<[string, string]> = [
      ['/work/x', '/work'], ['/work2/x', '/work'], ['/work', '/work'], ['/work/x', '/work/'],
      ['/WORK/x', '/work'], ['/work/a\\b', '/work/a'], ['/anything', '/'], ['/x', 'relative'],
      ['/work/x', ''], ['/work/x', '/'], ['C:/x', '/'], ['\\srv\\share\\x', '/'],
      ['C:/WS/sub/x.txt', 'c:\\ws'], ['C:\\work2\\x', 'C:/work'], ['C:/x', 'C:/'],
      ['C:\\proj\\a.txt', 'C:/proj'], ['D:\\proj\\a.txt', 'C:/proj'], ['C:/work', 'C:'],
      ['//SRV/SHARE/x', '\\\\srv\\share'], ['//srv/other/x', '\\\\srv\\share'],
      ['\\\\SRV\\SHARE\\x', '//srv/share'], ['\\\\srv\\share\\x', '\\\\srv\\share'],
      ['\\\\srv\\share', '\\\\srv\\share'], ['//srv/share/a/b', '\\\\srv\\share\\a'],
      ['\\\\?\\C:\\work\\x', 'C:\\work'], ['C:/work/x', '\\\\work'],
    ]
    for (const [path, root] of pairs) {
      expect({ path, root, inside: server.isUnderPath(path, root) }).toEqual({ path, root, inside: isUnderPath(path, root) })
    }
  })

  it('requires a root that is itself absolute', () => {
    expect(server.isUnderPath('/work/x', 'relative')).toBe(false)
    expect(server.isUnderPath('relative', '/work')).toBe(false)
  })
})

describe('dsh-skills frontmatter extraction agrees with parseSkillFrontmatter', () => {
  const cases = [
    '---\ndescription: Hello\n---\nbody',
    '\uFEFF---\r\ndescription: "Quoted"\r\n---\r\nbody',
    "---\ndescription: 'Single'\n---",
    '---\ndescription: "  spaced  "\n---\n',
    '---\ndescription: ""\n---',
    '---\nname: x\ndescription: after name\n---',
    '---\n# a comment\n\ndescription: commented\n---',
    '---\nmetadata:\n  description: nested\n---',
    '---\nmetadata:\n  owner: me\ndescription: top level\n---',
    '---\ndescription: first\ndescription: second\n---',
    '---\ndescription: has: colon\n---',
    '---\ndescription: unclosed\nbody\n',
    '---\n---\n',
    '---\nbad line here\ndescription: after\n---',
    'no frontmatter at all\n',
    '',
    '---\ndescription:\n---',
    '---\nmetadata:\n  - list item\ndescription: after list\n---',
  ]
  const hostValue = (text: string): Record<string, string> | null => {
    try {
      return parseSkillFrontmatter(text)
    } catch {
      return null
    }
  }

  it('matches the host parser wherever the host parser accepts the block', () => {
    for (const text of cases) {
      const host = hostValue(text)
      const ours = server.skillDescriptionFromFrontmatter(text)
      if (host === null) {
        // The host THROWS on a malformed block (its scanner skips the skill);
        // this server must instead keep the skill and answer "no description".
        expect({ text, ours }).toEqual({ text, ours: '' })
      } else {
        expect({ text, ours }).toEqual({ text, ours: host.description ?? '' })
      }
    }
  })

  it('answers empty for absent, unclosed and malformed blocks instead of throwing', () => {
    expect(server.skillDescriptionFromFrontmatter('plain body')).toBe('')
    expect(server.skillDescriptionFromFrontmatter('---\ndescription: x\n')).toBe('')
    expect(server.skillDescriptionFromFrontmatter('---\nnot a key value\n---\n')).toBe('')
  })
})

describe('dsh-skills name predicate', () => {
  it('accepts single alnum-led segments of at most 64 characters', () => {
    for (const name of ['a', 'A1', 'my-skill', 'my_skill', 'a.b.c', '9lives', 'x'.repeat(64)]) {
      expect({ name, valid: server.SKILL_NAME_PATTERN.test(name) }).toEqual({ name, valid: true })
    }
  })
  it('rejects separators, dot-leading names, NUL and over-long names', () => {
    for (const name of ['', '.hidden', '-lead', '_lead', 'a/b', 'a\\b', 'a b', 'a\0b', '..', 'x'.repeat(65)]) {
      expect({ name, valid: server.SKILL_NAME_PATTERN.test(name) }).toEqual({ name, valid: false })
    }
  })
})

describe('dsh-skills bounded reads', () => {
  it('stops at the line limit without pulling in the rest of the file', () => {
    const { dir } = tempTree()
    const file = join(dir, 'many.log')
    writeFileSync(file, Array.from({ length: 5000 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n'))
    const read = server.readBoundedText(file, { maxLines: 400 })
    expect(read.lineLimited).toBe(true)
    expect(read.charLimited).toBe(false)
    expect(read.text.split('\n').filter(line => line !== '')).toHaveLength(400)
    // The proof that matters: fewer bytes were read than the file holds.
    expect(read.bytesRead).toBeLessThan(200 * 1024)
  })

  it('stops at the character limit even for one enormous line', () => {
    const { dir } = tempTree()
    const file = join(dir, 'one-line.txt')
    writeFileSync(file, 'a'.repeat(8 * 1024 * 1024))
    const read = server.readBoundedText(file, { maxChars: server.MAX_OUTPUT_CHARS })
    expect(read.charLimited).toBe(true)
    expect(read.text.length).toBe(server.MAX_OUTPUT_CHARS)
    expect(read.bytesRead).toBeLessThan(200 * 1024)
  })

  it('leaves a file exactly at the line limit untouched, marker included nowhere', () => {
    const { dir } = tempTree()
    const exact = join(dir, 'exact.md')
    writeFileSync(exact, `${Array.from({ length: 400 }, (_, index) => `row ${index}`).join('\n')}\n`)
    expect(server.readSkillOutput(exact)).not.toContain('[truncated:')
    const extra = join(dir, 'extra.md')
    writeFileSync(extra, `${Array.from({ length: 401 }, (_, index) => `row ${index}`).join('\n')}\n`)
    const output = server.readSkillOutput(extra)
    expect(output).toContain('[truncated: line limit reached]')
    expect(output).toContain('row 399')
    expect(output).not.toContain('row 400')
  })

  it('never exceeds the output ceiling, marker included', () => {
    const { dir } = tempTree()
    const file = join(dir, 'huge.md')
    writeFileSync(file, 'b'.repeat(8 * 1024 * 1024))
    const output = server.readSkillOutput(file, 10)
    expect(output.length).toBeLessThanOrEqual(server.MAX_OUTPUT_CHARS)
    expect(output).toContain('character limit reached')
  })

  it('spends the frontmatter budget in BYTES, so a multi-byte font cannot stretch it', () => {
    // 40 000 two-byte characters: 80 000+ bytes of frontmatter, 40 000
    // characters — a character-counted cap would have read the whole block and
    // found the closing `---`.
    const { dir, skills } = tempTree()
    const wide = `---\ndescription: ${'é'.repeat(40_000)}\n---\n`
    expect(Buffer.byteLength(wide)).toBeGreaterThan(server.FRONTMATTER_MAX_BYTES)
    const stretched = writeSkill(skills, 'wide', wide)
    const read = server.readBoundedText(stretched, { maxLines: server.FRONTMATTER_MAX_LINES, maxBytes: server.FRONTMATTER_MAX_BYTES })
    expect(read.bytesRead).toBe(server.FRONTMATTER_MAX_BYTES)
    expect(read.bytesLimited).toBe(true)
    expect(read.text.length).toBeLessThan(40_000)
    // The block never closes inside the budget, so there is no description —
    // proving the cap actually applies instead of trusting the constant.
    expect(server.readFrontmatterDescription(stretched)).toBe('')

    // A block that fits is still read in full; an EOF exactly at the budget is
    // a complete read, not a truncation.
    const small = writeSkill(skills, 'small', frontmatter('small one'))
    expect(server.readFrontmatterDescription(small)).toBe('small one')
    const exact = join(dir, 'exact.md')
    writeFileSync(exact, 'a'.repeat(64))
    const exactRead = server.readBoundedText(exact, { maxBytes: 64 })
    expect(exactRead).toMatchObject({ bytesLimited: false, bytesRead: 64, text: 'a'.repeat(64) })
  })
})

describe('dsh-skills tool argument validation', () => {
  it('defaults and bounds maxLines', () => {
    expect(server.normalizeMaxLines(undefined)).toBe(400)
    expect(server.normalizeMaxLines(1)).toBe(1)
    expect(server.normalizeMaxLines(2000)).toBe(2000)
    for (const bad of [0, 2001, -1, 1.5, '400', null]) {
      expect(() => server.normalizeMaxLines(bad as never)).toThrow(/maxLines/)
    }
  })
  it('reduces a safe file argument and refuses every escaping form', () => {
    expect(server.normalizeSkillFile(undefined)).toBe('SKILL.md')
    expect(server.normalizeSkillFile('reference/notes.md')).toBe('reference/notes.md')
    expect(server.normalizeSkillFile('reference\\notes.md')).toBe('reference/notes.md')
    expect(server.normalizeSkillFile('./notes.md')).toBe('notes.md')
    for (const bad of ['', '../x', 'a/../../x', '..\\x', '/etc/passwd', 'C:\\x', 'C:x', '\\\\srv\\share\\x', '//?/C:/x', 'a\0b', '.', './']) {
      expect(() => server.normalizeSkillFile(bad)).toThrow(/"file"/)
    }
  })
})

// ---- the real stdio process ----

describe('dsh-skills stdio protocol', () => {
  it('negotiates the version, answers ping, and never answers a notification', async () => {
    const { stateDir } = tempTree()
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const init = await session.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      expect(init.result.protocolVersion).toBe('2025-03-26')
      expect(init.result.serverInfo.name).toBe('dsh-skills')
      expect(typeof init.result.serverInfo.version).toBe('string')
      expect(init.result.capabilities).toEqual({ tools: {} })

      const newest = await session.request('initialize', { protocolVersion: '1999-01-01' })
      expect(newest.result.protocolVersion).toBe('2025-06-18')

      session.notify('notifications/initialized')
      const ping = await session.request('ping')
      expect(ping.result).toEqual({})
      // A notification may not produce a frame: the ping response is the very next one.
      expect(session.frames.map(frame => frame.id)).toEqual([1, 2, 3])
    } finally {
      await session.close()
    }
  })

  it('declares exactly two static tools with the documented schema', async () => {
    const { stateDir } = tempTree()
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const listed = await session.request('tools/list')
      const tools = listed.result.tools as Array<{ name: string; inputSchema: any }>
      expect(tools.map(tool => tool.name)).toEqual(['skills_list', 'skill_read'])
      expect(tools[0].inputSchema.properties).toEqual({})

      const schema = tools[1].inputSchema
      expect(schema.required).toEqual(['name'])
      expect(schema.properties.name.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
      expect(schema.properties.file.default).toBe('SKILL.md')
      expect(schema.properties.maxLines).toMatchObject({ type: 'integer', default: 400, minimum: 1, maximum: 2000 })
    } finally {
      await session.close()
    }
  })

  it('exits on stdin EOF', async () => {
    const { stateDir } = tempTree()
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    await session.request('ping')
    await expect(session.close()).resolves.toBe(0)
  })

  it('never touches the skills root during initialize / initialized / ping / tools/list', async () => {
    // Canary: the root holds one directory whose name fails the skill predicate,
    // so ANY enumeration leaves a stderr line. The same line is proven to fire
    // on skills_list below — the canary observes the read, not the answer.
    const { skills, stateDir } = tempTree()
    mkdirSync(join(skills, '.invalid'), { recursive: true })
    writeFileSync(join(skills, '.invalid', 'SKILL.md'), frontmatter('hidden'))
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      await session.request('initialize', { protocolVersion: '2025-06-18' })
      session.notify('notifications/initialized')
      await session.request('ping')
      await session.request('tools/list')
      expect(session.stderr()).toBe('')

      const listed = await session.request('tools/call', { name: 'skills_list', arguments: {} })
      expect(listEntries(listed)).toEqual([])
      expect(session.stderr()).toContain('.invalid')
    } finally {
      await session.close()
    }
  })

  it('splits protocol errors (-32700 / -32601 / -32602) from tool failures', async () => {
    const { stateDir } = tempTree()
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const before = session.frames.length
      session.raw('this is not json')
      const parseError = await nextFrame(session, before)
      expect(parseError).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })

      const unknown = await session.request('no/such-method')
      expect(unknown.error.code).toBe(-32601)

      const noArguments = await session.request('tools/call', { name: 'skills_list' })
      // A missing `arguments` object is legal (`arguments ?? {}`); the answer is the empty listing.
      expect(noArguments.result.isError).toBeUndefined()
      expect(noArguments.result.content[0].text).toBe('[]')

      const noName = await session.request('tools/call', {})
      expect(noName.error.code).toBe(-32602)
      const arrayParams = await session.request('tools/call', [])
      expect(arrayParams.error.code).toBe(-32602)
      const badArgs = await session.request('tools/call', { name: 'skill_read', arguments: [] })
      expect(badArgs.error.code).toBe(-32602)

      const unknownTool = await session.request('tools/call', { name: 'nope', arguments: {} })
      expect(unknownTool.result.isError).toBe(true)
      expect(resultText(unknownTool)).toContain('unknown tool')
    } finally {
      await session.close()
    }
  })

  it('emits only single-line JSON-RPC frames on stdout', async () => {
    const { skills, stateDir } = tempTree()
    writeSkill(skills, 'alpha', frontmatter('Alpha'))
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      await session.request('initialize', { protocolVersion: '2024-11-05' })
      await session.request('tools/list')
      await session.request('tools/call', { name: 'skills_list', arguments: {} })
      expect(session.malformed).toEqual([])
      expect(session.frames.every(frame => frame.jsonrpc === '2.0')).toBe(true)
    } finally {
      await session.close()
    }
  })
})

describe('dsh-skills skills_list', () => {
  it('returns an empty array for a missing root', async () => {
    const { dir } = tempTree()
    const session = startServer({ DSH_NTR_STATE_DIR: join(dir, 'gone', 'nested') })
    try {
      const listed = await session.request('tools/call', { name: 'skills_list', arguments: {} })
      expect(listEntries(listed)).toEqual([])
    } finally {
      await session.close()
    }
  })

  it('lists direct children only, sorted, with realpath and description', async () => {
    const { skills, stateDir } = tempTree()
    const alphaPath = writeSkill(skills, 'alpha', frontmatter('"Alpha skill"'))
    writeSkill(skills, 'Beta_2.0', '\uFEFF---\r\ndescription: Beta desc\r\n---\r\nbody')
    writeSkill(skills, 'gamma', 'no frontmatter here')
    mkdirSync(join(skills, 'no-skill'), { recursive: true })
    writeSkill(skills, 'nested', '---\ndescription: outer\n---\n') // a deeper SKILL.md must not leak out
    writeSkill(skills, 'nested/child', frontmatter('child'))
    mkdirSync(join(skills, '.hidden'), { recursive: true })
    writeFileSync(join(skills, '.hidden', 'SKILL.md'), frontmatter('hidden'))
    writeFileSync(join(skills, 'stray.txt'), 'not a skill')
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const listed = await session.request('tools/call', { name: 'skills_list', arguments: {} })
      const entries = listEntries(listed)
      expect(entries.map(entry => entry.name)).toEqual(['Beta_2.0', 'alpha', 'gamma', 'nested'])
      expect(entries[0].description).toBe('Beta desc')
      expect(entries[1].description).toBe('Alpha skill')
      expect(entries[2].description).toBe('')
      expect(entries[1].path).toBe(alphaPath)
      expect(entries.every(entry => resolve(entry.path) === entry.path)).toBe(true)
      // The shared predicate means "listed" implies "readable" — mixed case,
      // digits, underscores and dots included.
      const readBack = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'Beta_2.0' } })
      expect(readBack.result.isError).toBeUndefined()
      expect(resultText(readBack)).toContain('description: Beta desc')
      // A name that cannot be read is skipped AND reported — listable implies readable.
      expect(session.stderr()).toContain('.hidden')
    } finally {
      await session.close()
    }
  })

  it('observes added, edited and removed skills on the next call', async () => {
    const { skills, stateDir } = tempTree()
    writeSkill(skills, 'alpha', frontmatter('first'))
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const first = listEntries(await session.request('tools/call', { name: 'skills_list', arguments: {} }))
      expect(first.map(entry => entry.description)).toEqual(['first'])

      writeSkill(skills, 'alpha', frontmatter('second'))
      writeSkill(skills, 'beta', frontmatter('new'))
      const second = listEntries(await session.request('tools/call', { name: 'skills_list', arguments: {} }))
      expect(second.map(entry => `${entry.name}:${entry.description}`)).toEqual(['alpha:second', 'beta:new'])

      rmSync(join(skills, 'beta'), { recursive: true, force: true })
      const third = listEntries(await session.request('tools/call', { name: 'skills_list', arguments: {} }))
      expect(third.map(entry => entry.name)).toEqual(['alpha'])
    } finally {
      await session.close()
    }
  })

  it('caps the entry count and marks the truncation', async () => {
    const { skills, stateDir } = tempTree()
    for (let index = 0; index < 210; index += 1) {
      writeSkill(skills, `skill-${String(index).padStart(3, '0')}`, frontmatter(`desc ${index}`))
    }
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const listed = await session.request('tools/call', { name: 'skills_list', arguments: {} })
      expect(listEntries(listed)).toHaveLength(200)
      expect(listed.result.content).toHaveLength(2)
      expect(resultText(listed)).toContain('10 more skills omitted')
    } finally {
      await session.close()
    }
  })

  it('caps one description and the total serialized output', async () => {
    const { skills, stateDir } = tempTree()
    // Sorted first, so the description cap is judged on an entry that survives the cut.
    writeSkill(skills, 'aaa-long', frontmatter('d'.repeat(1500)))
    for (let index = 0; index < 150; index += 1) {
      writeSkill(skills, `bulk-${String(index).padStart(3, '0')}`, frontmatter(`${index}-${'e'.repeat(990)}`))
    }
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const listed = await session.request('tools/call', { name: 'skills_list', arguments: {} })
      const entries = listEntries(listed)
      const long = entries.find(entry => entry.name === 'aaa-long')
      expect(long?.description).toHaveLength(1000)
      expect(long?.description.endsWith('…')).toBe(true)
      // 151 entries at ~1 KB each cannot fit: the array is cut and the marker is a second block.
      expect(entries.length).toBeLessThan(151)
      expect(listed.result.content).toHaveLength(2)
      expect(resultText(listed).length).toBeLessThanOrEqual(server.MAX_OUTPUT_CHARS)
      expect(resultText(listed)).toContain('more skills omitted')
    } finally {
      await session.close()
    }
  })

  // 0o000 is the only portable way to make a FILE unreadable without ACLs; it
  // does nothing for root, and mode bits are not a Windows concept — both are
  // skipped rather than asserted into a false green.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips a skill whose SKILL.md cannot be read', () => {
    const { skills } = tempTree()
    writeSkill(skills, 'alpha', frontmatter('Alpha'))
    chmodSync(writeSkill(skills, 'blocked', frontmatter('Blocked')), 0o000)
    const warnings: string[] = []
    const entries = server.listSkills({ root: skills, warn: (line: string) => warnings.push(line) })
    // "listed" still implies "readable": the unreadable one is neither.
    expect(entries.map(entry => entry.name)).toEqual(['alpha'])
    expect(warnings.join('\n')).toContain('blocked')
    expect(() => server.readSkill({ name: 'blocked', root: skills })).toThrow()
  })

  // A FIFO passes `realpath` and would block the whole server on `open(2)` —
  // the `isFile()` gate in front of every read is what keeps this a refusal.
  // No FIFO on Windows, so the case only runs where `mkfifo` exists.
  it.skipIf(process.platform === 'win32')('refuses a SKILL.md that is a FIFO instead of reading it', () => {
    const { skills } = tempTree()
    writeSkill(skills, 'alpha', frontmatter('Alpha'))
    mkdirSync(join(skills, 'pipe'), { recursive: true })
    execFileSync('mkfifo', [join(skills, 'pipe', 'SKILL.md')])
    const entries = server.listSkills({ root: skills, warn: () => {} })
    expect(entries.map(entry => entry.name)).toEqual(['alpha'])
    expect(() => server.readSkill({ name: 'pipe', root: skills })).toThrow(/not a regular file/)
  })
})

describe('dsh-skills skill_read', () => {
  it('reads SKILL.md by default, honours file and maxLines, and marks truncation', async () => {
    const { skills, stateDir } = tempTree()
    const body = Array.from({ length: 20 }, (_, index) => `row ${index}`).join('\n')
    writeSkill(skills, 'alpha', frontmatter('Alpha', `${body}\n`))
    writeSkill(skills, 'alpha', 'note body\n', 'reference/notes.md')
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const full = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha' } })
      expect(resultText(full)).toContain('description: Alpha')
      expect(resultText(full)).toContain('row 19')
      expect(resultText(full)).not.toContain('[truncated:')

      const extra = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha', file: 'reference/notes.md', maxLines: 5 } })
      expect(resultText(extra)).toBe('note body\n')

      const limited = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha', maxLines: 2 } })
      expect(resultText(limited)).toContain('[truncated: line limit reached]')
      expect(resultText(limited).split('\n')[0]).toBe('---')
      expect(resultText(limited)).not.toContain('row 0')

      for (const maxLines of [0, 2001, 1.5, '400', null]) {
        const rejected = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha', maxLines } })
        expect({ maxLines, isError: rejected.result.isError }).toEqual({ maxLines, isError: true })
      }
    } finally {
      await session.close()
    }
  })

  it('refuses every name and file escape in the attack matrix', async () => {
    const { dir, skills, stateDir } = tempTree()
    writeSkill(skills, 'alpha', frontmatter('Alpha'))
    writeSkill(skills, 'alpha', 'secret\n', 'reference/notes.md')
    mkdirSync(join(skills, 'alpha', 'reference', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'outside.txt'), 'outside\n')
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const badNames = ['../alpha', 'a/b', 'a\\b', 'C:\\Windows', '/etc', '..', '.hidden', 'alpha\0', '']
      for (const name of badNames) {
        const frame = await session.request('tools/call', { name: 'skill_read', arguments: { name } })
        expect({ name, isError: frame.result.isError }).toEqual({ name, isError: true })
      }

      const badFiles = [
        '../outside.txt', '..\\outside.txt', 'reference/../../outside.txt', 'a\\..\\..\\outside.txt',
        '/etc/passwd', 'C:\\Windows\\win.ini', 'C:win.ini', '\\\\srv\\share\\x', '//srv/share/x',
        '//?/C:/x', '\\\\?\\C:\\x', 'alpha\0.txt', '', '.', './',
      ]
      for (const file of badFiles) {
        const frame = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha', file } })
        expect({ file, isError: frame.result.isError }).toEqual({ file, isError: true })
      }

      const directory = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha', file: 'reference' } })
      expect(directory.result.isError).toBe(true)
      expect(resultText(directory)).toContain('not a regular file')

      const missingSkill = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'ghost' } })
      expect(missingSkill.result.isError).toBe(true)
      expect(resultText(missingSkill)).toContain('not found')
    } finally {
      await session.close()
    }
  })

  it('refuses symlinks that resolve outside the skills root and allows in-root ones', async () => {
    const { dir, skills, stateDir } = tempTree()
    writeSkill(skills, 'alpha', frontmatter('Alpha'))
    writeSkill(skills, 'alpha', 'inside\n', 'reference/inside.md')
    mkdirSync(join(dir, 'outside-dir'), { recursive: true })
    writeFileSync(join(dir, 'outside-dir', 'secret.md'), 'secret\n')
    const linkSkill = join(skills, 'linked-out')
    const linkFile = join(skills, 'alpha', 'escape.md')
    const linkInside = join(skills, 'alpha', 'inside-link.md')
    const linkDirInside = join(skills, 'linked-in')
    try {
      symlinkSync(join(dir, 'outside-dir'), linkSkill, 'junction')
      symlinkSync(join(dir, 'outside-dir', 'secret.md'), linkFile, 'file')
      symlinkSync(join(skills, 'alpha', 'reference', 'inside.md'), linkInside, 'file')
      symlinkSync(join(skills, 'alpha'), linkDirInside, 'junction')
    } catch {
      return // creating symlinks needs a privilege on some Windows setups — nothing to assert then
    }
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const outsideSkill = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'linked-out' } })
      expect(outsideSkill.result.isError).toBe(true)

      const outsideFile = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha', file: 'escape.md' } })
      expect(outsideFile.result.isError).toBe(true)

      const insideLink = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha', file: 'inside-link.md' } })
      expect(resultText(insideLink)).toBe('inside\n')

      const insideDir = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'linked-in' } })
      expect(resultText(insideDir)).toContain('description: Alpha')

      const listing = listEntries(await session.request('tools/call', { name: 'skills_list', arguments: {} }))
      expect(listing.map(entry => entry.name)).not.toContain('linked-out')
    } finally {
      await session.close()
    }
  })

  it('reads the current disk content and does not scan other skills', async () => {
    const { skills, stateDir } = tempTree()
    writeSkill(skills, 'alpha', frontmatter('Alpha', 'first body\n'))
    mkdirSync(join(skills, '.invalid'), { recursive: true })
    writeFileSync(join(skills, '.invalid', 'SKILL.md'), frontmatter('nope'))
    const session = startServer({ DSH_NTR_STATE_DIR: stateDir })
    try {
      const before = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha' } })
      expect(resultText(before)).toContain('first body')

      writeSkill(skills, 'alpha', frontmatter('Alpha', 'second body\n'))
      const after = await session.request('tools/call', { name: 'skill_read', arguments: { name: 'alpha' } })
      expect(resultText(after)).toContain('second body')
      // A read resolves its own target only: the invalid sibling would only be
      // named by a listing scan.
      expect(session.stderr()).toBe('')
    } finally {
      await session.close()
    }
  })

  it('refuses to read anything when the skills root itself is missing', () => {
    const { dir } = tempTree()
    expect(() => server.readSkill({ name: 'alpha', root: join(dir, 'gone') })).toThrow(/skills root/)
  })

  it('reads through the skills-root rule the plugin uses (state dir parent)', () => {
    const tree = tempTree()
    const root = server.skillsRoot({ DSH_NTR_STATE_DIR: tree.stateDir } as NodeJS.ProcessEnv)
    expect(relative(tree.dir, root).split('\\').join('/')).toBe('skills')
    const fallback = server.skillsRoot({} as NodeJS.ProcessEnv, tree.dir)
    expect(relative(dirname(join(tree.dir, '.dsh', 'dsh-ntr')), fallback).split('\\').join('/')).toBe('skills')
  })
})
