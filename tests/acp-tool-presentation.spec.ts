import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ACP_TOOL_CALL_NAME,
  abbreviateHomePath,
  classifyAcpTool,
  parseAcpToolPresentation,
  relativizeToCwd,
  type AcpToolArgsView,
} from '../src/client/acp-tool-presentation.ts'
import { ACP_TOOL_CALL_NAME as HOST_ACP_TOOL_CALL_NAME } from '../src/impl.ts'

describe('ACP tool presentation constants & bundle boundary', () => {
  it('matches the host ACP_TOOL_CALL_NAME constant', () => {
    expect(ACP_TOOL_CALL_NAME).toBe(HOST_ACP_TOOL_CALL_NAME)
    expect(ACP_TOOL_CALL_NAME).toBe('dsh_ntr__acp_tool_call')
  })

  it('keeps browser files free of host or Node imports', () => {
    for (const file of ['src/client/acp-tool-presentation.ts', 'src/client/acp-tool-view.tsx']) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/from\s+['"]\.\.?\/impl(?:\.ts)?['"]/)
      expect(source).not.toMatch(/from\s+['"]node:/)
    }
  })
})

describe('classifyAcpTool', () => {
  it('classifies by ACP kind first for every standard kind', () => {
    const cases = [
      ['execute', 'execute'],
      ['read', 'read'],
      ['edit', 'edit'],
      ['delete', 'delete'],
      ['move', 'move'],
      ['search', 'search'],
      ['fetch', 'fetch'],
      ['think', 'think'],
      ['switch_mode', 'switch_mode'],
    ] as const
    for (const [kind, expected] of cases) {
      expect(classifyAcpTool(kind, undefined)).toBe(expected)
    }
    // kind takes precedence over tool name
    expect(classifyAcpTool('read', 'bash')).toBe('read')
  })

  it('falls through from missing or other kind to exact tool name lookup', () => {
    expect(classifyAcpTool(undefined, 'bash')).toBe('execute')
    expect(classifyAcpTool('other', 'sh')).toBe('execute')
    expect(classifyAcpTool(undefined, 'shell')).toBe('execute')
    expect(classifyAcpTool(undefined, 'exec_command')).toBe('execute')
    expect(classifyAcpTool(undefined, 'Bash')).toBe('execute')

    expect(classifyAcpTool(undefined, 'read')).toBe('read')
    expect(classifyAcpTool(undefined, 'view_file')).toBe('read')
    expect(classifyAcpTool(undefined, 'read_file')).toBe('read')

    expect(classifyAcpTool(undefined, 'edit')).toBe('edit')
    expect(classifyAcpTool(undefined, 'write')).toBe('edit')
    expect(classifyAcpTool(undefined, 'apply_patch')).toBe('edit')
    expect(classifyAcpTool(undefined, 'str_replace_editor')).toBe('edit')

    expect(classifyAcpTool(undefined, 'grep')).toBe('search')
    expect(classifyAcpTool(undefined, 'glob')).toBe('search')
    expect(classifyAcpTool(undefined, 'ripgrep')).toBe('search')
    expect(classifyAcpTool(undefined, 'find_by_name')).toBe('search')

    expect(classifyAcpTool(undefined, 'web_search')).toBe('fetch')
    expect(classifyAcpTool(undefined, 'webfetch')).toBe('fetch')
    expect(classifyAcpTool(undefined, 'web_fetch')).toBe('fetch')

    expect(classifyAcpTool(undefined, 'task')).toBe('subagent')
    expect(classifyAcpTool(undefined, 'agent')).toBe('subagent')

    expect(classifyAcpTool(undefined, 'todowrite')).toBe('plan')
    expect(classifyAcpTool(undefined, 'todo_write')).toBe('plan')

    // Exact lookup only — never substring-match
    expect(classifyAcpTool(undefined, 'my_bash_helper')).toBe('other')
    expect(classifyAcpTool('other', 'mcp__github__search_issues')).toBe('other')
  })
})

describe('path helpers', () => {
  it('relativizes workspace paths and abbreviates POSIX home', () => {
    expect(relativizeToCwd('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(relativizeToCwd('C:\\repo\\src\\a.ts', 'C:/repo')).toBe('src\\a.ts')
    expect(relativizeToCwd('/other/a.ts', '/repo')).toBe('/other/a.ts')
    expect(abbreviateHomePath('/home/alice/notes.md', '/home/alice')).toBe('~/notes.md')
    expect(abbreviateHomePath('C:\\Users\\alice\\notes.md', 'C:\\Users\\alice')).toBe('C:\\Users\\alice\\notes.md')
  })
})

describe('parseAcpToolPresentation', () => {
  it('renders known tool categories with bilingual titles and command-styled execute input', () => {
    const model = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({
        description: 'Run unit tests',
        kind: 'execute',
        tool: 'bash',
        input: { command: 'npm test', timeout: 5000 },
      }),
      resultContent: [{ type: 'text', text: 'All tests passed' }],
      isError: false,
    })

    expect(model.category).toBe('execute')
    expect(model.iconKey).toBe('execute')
    expect(model.title).toEqual({ zh: '运行命令', en: 'Execute' })
    expect(model.summary).toBe('Run unit tests')
    expect(model.inputIsCommand).toBe(true)
    expect(model.inputText).toBe('npm test')
    expect(model.outputText).toBe('All tests passed')
    expect(model.state).toBe('ok')
  })

  it('uses raw tool name as title when kind is missing/other and tool is an MCP/custom tool', () => {
    const model = parseAcpToolPresentation({
      phase: 'start',
      argsRaw: JSON.stringify({
        description: 'List open issues',
        kind: 'other',
        tool: 'mcp__github__list_issues',
        input: { repo: 'deepseek/dsh' },
      }),
    })

    expect(model.category).toBe('other')
    expect(model.title).toEqual({ zh: 'mcp__github__list_issues', en: 'mcp__github__list_issues' })
    expect(model.summary).toBe('List open issues')
    expect(model.inputIsCommand).toBe(false)
    expect(model.state).toBe('running')
  })

  it('stays backwards-compatible with legacy { description, input } and plain strings', () => {
    const legacy = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({ description: 'Check status', input: 'git status' }),
      resultContent: [{ type: 'text', text: 'clean' }],
      isError: false,
    })
    expect(legacy.category).toBe('other')
    expect(legacy.title).toEqual({ zh: '工具调用', en: 'Tool call' })
    expect(legacy.summary).toBe('Check status')
    expect(legacy.inputText).toBe('git status')
    expect(legacy.outputText).toBe('clean')

    const plain = parseAcpToolPresentation({
      phase: 'start',
      argsRaw: 'ls -la',
    })
    expect(plain.summary).toBe('ls -la')
    expect(plain.inputText).toBe('ls -la')
  })

  it('extracts filePath, line, and relativizes file-op summaries against cwd/home', () => {
    const fromLocation = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({
        description: 'Read /repo/src/index.ts',
        kind: 'read',
        tool: 'read_file',
        locations: [{ path: '/repo/src/index.ts', line: 25 }],
      }),
      cwd: '/repo',
      home: '/home/alice',
      isError: false,
    })
    expect(fromLocation.filePath).toBe('/repo/src/index.ts')
    expect(fromLocation.filePathLine).toBe(25)
    expect(fromLocation.summary).toBe('Read src/index.ts')

    const fromInputHome = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({
        kind: 'edit',
        input: { file_path: '/home/alice/notes.md', line: 9 },
      }),
      cwd: '/repo',
      home: '/home/alice',
      isError: false,
    })
    expect(fromInputHome.filePath).toBe('/home/alice/notes.md')
    expect(fromInputHome.filePathLine).toBe(9)
    expect(fromInputHome.summary).toBe('~/notes.md')
  })

  it('reads streaming ToolArgs during preparing without tripping on incomplete kind/tool', () => {
    const partialArgs: AcpToolArgsView = {
      has: key => key === 'description' || key === 'kind',
      complete: key => key === 'description' ? false : false,
      text: key => (key === 'description' ? 'Reading src/app.ts' : key === 'kind' ? 're' : undefined),
      value: () => undefined,
    }
    const partial = parseAcpToolPresentation({
      phase: 'preparing',
      args: partialArgs,
    })
    expect(partial.state).toBe('preparing')
    expect(partial.summary).toBe('Reading src/app.ts')
    expect(partial.category).toBe('other')

    const completedKindArgs: AcpToolArgsView = {
      has: key => key === 'description' || key === 'kind' || key === 'locations',
      complete: () => true,
      text: key => (key === 'description' ? '/repo/src/app.ts' : key === 'kind' ? 'read' : undefined),
      value: key => (key === 'locations' ? [{ path: '/repo/src/app.ts', line: 10 }] : undefined),
    }
    const ready = parseAcpToolPresentation({
      phase: 'preparing',
      args: completedKindArgs,
      cwd: '/repo',
    })
    expect(ready.category).toBe('read')
    expect(ready.filePath).toBe('/repo/src/app.ts')
    expect(ready.filePathLine).toBe(10)
    expect(ready.summary).toBe('src/app.ts')

    const streamingInputArgs: AcpToolArgsView = {
      has: key => key === 'description' || key === 'kind' || key === 'input',
      complete: key => key === 'kind',
      text: key => (key === 'description' ? 'Run tests' : key === 'kind' ? 'execute' : key === 'input' ? 'npm test' : undefined),
      value: () => undefined,
    }
    const streamingInput = parseAcpToolPresentation({
      phase: 'preparing',
      args: streamingInputArgs,
    })
    expect(streamingInput.state).toBe('preparing')
    expect(streamingInput.inputIsCommand).toBe(true)
    expect(streamingInput.inputText).toBe('npm test')
  })

  it('enriches frozen result args and fallback diffs from live SSE updates while preserving authoritative result output', () => {
    const merged = parseAcpToolPresentation({
      phase: 'preparing',
      args: {
        has: key => key === 'description' || key === 'kind',
        complete: () => true,
        text: key => (key === 'description' ? 'shell' : key === 'kind' ? 'execute' : undefined),
      },
      live: {
        title: 'npm run verify',
        kind: 'execute',
        tool: 'bash',
        rawInput: { command: 'npm run verify' },
        outputText: 'running tests...',
        diffs: [{ path: '/repo/a.ts', oldText: 'a', newText: 'b' }],
      },
      cwd: '/repo',
    })
    expect(merged.state).toBe('preparing')
    expect(merged.summary).toBe('npm run verify')
    expect(merged.inputText).toBe('npm run verify')
    expect(merged.outputText).toBe('running tests...')
    expect(merged.diffs).toEqual([{ path: '/repo/a.ts', oldText: 'a', newText: 'b' }])

    const settled = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({ description: 'shell', kind: 'execute' }),
      resultContent: [{ type: 'text', text: 'done' }],
      isError: false,
      live: {
        title: 'echo done',
        rawInput: { command: 'echo done' },
        outputText: 'stale live output',
        diffs: [{ path: '/repo/a.ts', oldText: 'a', newText: 'b' }],
      },
    })
    expect(settled.summary).toBe('echo done')
    expect(settled.inputText).toBe('echo done')
    expect(settled.outputText).toBe('done')
    expect(settled.diffs).toEqual([{ path: '/repo/a.ts', oldText: 'a', newText: 'b' }])
  })

  it('extracts structured diffs, error summaries, and interrupted state', () => {
    const withMetaDiffs = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({ kind: 'edit', description: 'Update foo.ts' }),
      meta: {
        diffs: [{ path: '/repo/foo.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
      },
      isError: false,
    })
    expect(withMetaDiffs.diffs).toEqual([{ path: '/repo/foo.ts', oldText: 'const a = 1', newText: 'const a = 2' }])

    const withContentDiff = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({ kind: 'edit', description: 'Patch bar.ts' }),
      resultContent: [
        { type: 'diff', path: 'bar.ts', oldText: null, newText: 'export {}' },
        { type: 'text', text: 'Updated bar.ts' },
      ],
      isError: false,
    })
    expect(withContentDiff.diffs).toEqual([{ path: 'bar.ts', oldText: null, newText: 'export {}' }])
    expect(withContentDiff.outputText).toBe('Updated bar.ts')

    const failed = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({ kind: 'execute', description: 'Run check' }),
      resultContent: [{ type: 'text', text: 'Exit code 1\nMore details' }],
      isError: true,
    })
    expect(failed.state).toBe('error')
    expect(failed.errorSummary).toBe('Exit code 1')

    const stopped = parseAcpToolPresentation({
      phase: 'result',
      argsRaw: JSON.stringify({ kind: 'execute', description: 'Run check' }),
      error: { name: 'AbortError', code: 'interrupted' },
      isError: true,
    })
    expect(stopped.state).toBe('stopped')
  })
})
