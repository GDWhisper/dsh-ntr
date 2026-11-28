import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createBridgeHarness, def, MOCK } from './harness.ts'

describe.skipIf(process.platform === 'win32')('POSIX agent executable symlinks', () => {
  let bin: string
  let alias: string

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'dsh-ntr-bin-'))
    alias = join(bin, 'mock-acp')
    // A single program serves multiple commands and starts the ACP agent only under its alias.
    writeFileSync(join(bin, 'dispatcher'), '#!/bin/sh\n[ "${0##*/}" = mock-acp ] || exit 2\nexec "$@"\n', { mode: 0o755 })
    symlinkSync('dispatcher', alias)
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(bin, { recursive: true, force: true })
  })

  it.each(['PATH', 'absolute path', 'relative path'] as const)('handshakes through a symlink supplied by %s', async (form) => {
    const commands = { PATH: 'mock-acp', 'absolute path': alias, 'relative path': relative(process.cwd(), alias) }
    const { manager } = createBridgeHarness()
    try {
      const result = await manager.testAgent({ ...def, command: commands[form], args: [process.execPath, MOCK] })
      expect(result.ok, result.error).toBe(true)
    } finally {
      await manager.shutdownAll()
    }
  })
})
