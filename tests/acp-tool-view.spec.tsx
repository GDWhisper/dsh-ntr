// @vitest-environment jsdom
import { createElement, memo, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ACP_TOOL_CALL_NAME } from '../src/client/acp-tool-presentation.ts'
import { AcpToolRow, installAcpToolView, type AcpToolRowProps } from '../src/client/acp-tool-view.tsx'
import { AcpStore } from '../src/client/store.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('@deepseek-ai/dsh-client-ui-primitives')
})

function makeDisclosure(initial = false) {
  return () => {
    const [expanded, setExpanded] = useState(initial)
    return {
      expanded,
      setExpanded,
      toggle: () => { setExpanded(v => !v) },
    }
  }
}

function makeStore(preferZh = false): AcpStore {
  return new AcpStore(
    async () => ({ ok: true, value: {} }),
    (zh, en) => (preferZh ? zh : en),
  )
}

function renderRow(overrides: Partial<AcpToolRowProps> = {}) {
  const props: AcpToolRowProps = {
    callId: 'call-1',
    toolName: ACP_TOOL_CALL_NAME,
    phase: 'result',
    block: {
      kind: 'tool-result',
      callId: 'call-1',
      name: ACP_TOOL_CALL_NAME,
      args: {},
      call: {
        name: ACP_TOOL_CALL_NAME,
        argsRaw: JSON.stringify({
          description: 'Run tests',
          kind: 'execute',
          tool: 'bash',
          input: { command: 'npm test' },
        }),
      },
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    },
    useDisclosure: makeDisclosure(false),
    ...overrides,
  }
  return render(createElement(AcpToolRow, props))
}

describe('AcpToolRow (fallback primitives on older hosts / primitives-stub)', () => {
  it('renders category title, summary, command input, output, and inspect button', () => {
    const inspect = vi.fn()
    const { container } = renderRow({ inspect, acp: makeStore(false) })

    expect(screen.getByText('Execute')).toBeDefined()
    expect(screen.getByText('Run tests')).toBeDefined()

    // Click row to expand
    const row = container.querySelector('.ntr-tool-row') as HTMLElement
    fireEvent.click(row)

    const cmd = container.querySelector('[data-command="true"]')
    expect(cmd?.textContent).toBe('npm test')
    expect(screen.getByText('ok')).toBeDefined()

    const inspectBtn = screen.getByRole('button', { name: 'Inspect' })
    fireEvent.click(inspectBtn)
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('renders clickable openFile button on successful file ops and passes line without toggling row', () => {
    const openFile = vi.fn()
    const { container } = renderRow({
      acp: makeStore(false),
      cwd: '/repo',
      openFile,
      block: {
        kind: 'tool-result',
        callId: 'call-2',
        name: ACP_TOOL_CALL_NAME,
        args: {},
        call: {
          name: ACP_TOOL_CALL_NAME,
          argsRaw: JSON.stringify({
            description: '/repo/src/app.ts',
            kind: 'read',
            tool: 'read_file',
            locations: [{ path: '/repo/src/app.ts', line: 17 }],
            input: { path: '/repo/src/app.ts' },
          }),
        },
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      },
    })

    expect(screen.getByText('Read')).toBeDefined()
    const fileBtn = screen.getByRole('button', { name: 'src/app.ts' })
    fireEvent.click(fileBtn)

    expect(openFile).toHaveBeenCalledWith('/repo/src/app.ts', { line: 17 })
    // Clicking the file link must not expand the disclosure
    expect(container.querySelector('.ntr-tool-body-wrap')).toBeNull()
  })

  it('does not render clickable openFile button when result failed or still running', () => {
    const openFile = vi.fn()
    renderRow({
      acp: makeStore(false),
      cwd: '/repo',
      openFile,
      block: {
        kind: 'tool-result',
        callId: 'call-err',
        name: ACP_TOOL_CALL_NAME,
        args: {},
        call: {
          name: ACP_TOOL_CALL_NAME,
          argsRaw: JSON.stringify({
            description: '/repo/missing.ts',
            kind: 'read',
            locations: [{ path: '/repo/missing.ts' }],
          }),
        },
        content: [{ type: 'text', text: 'ENOENT: no such file' }],
        isError: true,
      },
    })

    expect(screen.queryByRole('button', { name: 'missing.ts' })).toBeNull()
    expect(screen.getByText('ENOENT: no such file')).toBeDefined()

    cleanup()
    renderRow({
      phase: 'start',
      acp: makeStore(false),
      cwd: '/repo',
      openFile,
      block: {
        phase: 'start',
        callId: 'call-run',
        name: ACP_TOOL_CALL_NAME,
        argsRaw: JSON.stringify({
          description: '/repo/running.ts',
          kind: 'read',
          locations: [{ path: '/repo/running.ts' }],
        }),
        args: {},
      },
    })
    expect(screen.queryByRole('button', { name: 'running.ts' })).toBeNull()
  })

  it('renders fallback diff rows when DiffBlock primitive is unavailable and error styling on failed output', () => {
    const { container } = renderRow({
      acp: makeStore(true),
      useDisclosure: makeDisclosure(true),
      block: {
        kind: 'tool-result',
        callId: 'call-diff',
        name: ACP_TOOL_CALL_NAME,
        args: {},
        call: {
          name: ACP_TOOL_CALL_NAME,
          argsRaw: JSON.stringify({
            description: 'Edit foo.ts',
            kind: 'edit',
          }),
        },
        meta: {
          diffs: [{ path: 'foo.ts', oldText: 'const x = 1', newText: 'const x = 2' }],
        },
        content: [{ type: 'text', text: 'Warning while saving' }],
        isError: true,
      },
    })

    expect(screen.getByText('编辑')).toBeDefined()
    expect(container.querySelector('.ntr-tool-diff-path')?.textContent).toBe('foo.ts')
    expect(container.querySelector('.ntr-tool-diff-row.is-del')?.textContent).toContain('const x = 1')
    expect(container.querySelector('.ntr-tool-diff-row.is-add')?.textContent).toContain('const x = 2')
    expect(container.querySelector('[data-error="true"]')?.textContent).toBe('Warning while saving')
  })

  it('shows MCP tool name instead of dsh_ntr__acp_tool_call when kind is other/missing', () => {
    renderRow({
      acp: makeStore(false),
      block: {
        kind: 'tool-result',
        callId: 'call-mcp',
        name: ACP_TOOL_CALL_NAME,
        args: {},
        call: {
          name: ACP_TOOL_CALL_NAME,
          argsRaw: JSON.stringify({
            description: 'Query issues',
            kind: 'other',
            tool: 'mcp__github__search_issues',
          }),
        },
        content: [{ type: 'text', text: '3 issues' }],
        isError: false,
      },
    })

    expect(screen.getByText('mcp__github__search_issues')).toBeDefined()
    expect(screen.queryByText(ACP_TOOL_CALL_NAME)).toBeNull()
  })

  it('disables expansion during preparing phase and streams live description', () => {
    const { container } = renderRow({
      phase: 'preparing',
      acp: makeStore(false),
      useDisclosure: makeDisclosure(true),
      block: {
        phase: 'preparing',
        callId: 'call-prep',
        name: ACP_TOOL_CALL_NAME,
        args: {
          has: k => k === 'description',
          complete: () => false,
          text: k => (k === 'description' ? 'Streaming command...' : undefined),
        },
      },
    })

    expect(screen.getByText('Streaming command...')).toBeDefined()
    expect(container.querySelector('.ntr-tool-body-wrap')).toBeNull()
  })
})

describe('AcpToolRow with host React.memo primitives', () => {
  it('uses host DisclosureRow, TextShimmer, DiffBlock, and Icons when exported (including memo components)', async () => {
    const DisclosureRow = memo(function MockDisclosureRow(props: {
      icon: unknown
      title: unknown
      open: boolean
      expandable: boolean
      onToggle: () => void
      collapsedContent?: unknown
      children?: unknown
    }) {
      return createElement(
        'div',
        { 'data-host-disclosure': String(props.open) },
        createElement('span', { 'data-host-icon': '' }, props.icon as never),
        createElement('span', { 'data-host-title': '' }, props.title as never),
        props.collapsedContent as never,
        props.open ? (props.children as never) : null,
      )
    })
    const TextShimmer = memo(function MockTextShimmer(props: { children: unknown }) {
      return createElement('span', { 'data-host-shimmer': '' }, props.children as never)
    })
    const DiffBlock = function MockDiffBlock(props: { diffs: readonly { path: string }[] }) {
      return createElement('div', { 'data-host-diff-block': props.diffs.map(d => d.path).join(',') })
    }
    const IconEditOutlineRegular = function MockEditIcon() {
      return createElement('span', { 'data-host-edit-icon': '1' })
    }
    const IconInspectOutlineRegular = function MockInspectIcon() {
      return createElement('span', { 'data-host-inspect-icon': '1' })
    }

    vi.doMock('@deepseek-ai/dsh-client-ui-primitives', () => ({
      DisclosureRow,
      TextShimmer,
      DiffBlock,
      IconEditOutlineRegular,
      IconInspectOutlineRegular,
      Tooltip: ({ children }: { children: unknown }) => children,
    }))

    const { AcpToolRow: HostAcpToolRow } = await import('../src/client/acp-tool-view.tsx')
    const { container } = render(createElement(HostAcpToolRow, {
      callId: 'call-host',
      toolName: ACP_TOOL_CALL_NAME,
      phase: 'result',
      acp: makeStore(false),
      useDisclosure: makeDisclosure(true),
      block: {
        kind: 'tool-result',
        callId: 'call-host',
        name: ACP_TOOL_CALL_NAME,
        args: {},
        call: {
          name: ACP_TOOL_CALL_NAME,
          argsRaw: JSON.stringify({ description: 'Edit src/a.ts', kind: 'edit' }),
        },
        meta: {
          diffs: [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }],
        },
        content: [],
        isError: false,
      },
    }))

    expect(container.querySelector('[data-host-disclosure="true"]')).not.toBeNull()
    expect(container.querySelector('[data-host-edit-icon="1"]')).not.toBeNull()
    expect(container.querySelector('[data-host-shimmer]')).not.toBeNull()
    expect(container.querySelector('[data-host-diff-block="src/a.ts"]')).not.toBeNull()
  })
})

describe('installAcpToolView', () => {
  it('registers keyed tool.call.toolview entry for dsh_ntr__acp_tool_call', () => {
    const registrations: unknown[] = []
    const dispose = vi.fn()
    const fakeCtx = {
      slots: {
        inject: vi.fn((slot: string, factory: () => () => void) => {
          expect(slot).toBe('tool.call.toolview')
          const unreg = factory()
          return () => { unreg(); dispose() }
        }),
        register: vi.fn((meta: unknown, comp: unknown) => {
          registrations.push({ meta, comp })
          return vi.fn()
        }),
      },
    } as unknown as Context

    const store = makeStore()
    const stop = installAcpToolView(fakeCtx, store)
    expect(typeof stop).toBe('function')
    expect(registrations).toHaveLength(1)
    expect((registrations[0] as { meta: { name: string; key: string; inject: () => unknown } }).meta.name).toBe('tool.call.toolview')
    expect((registrations[0] as { meta: { key: string } }).meta.key).toBe(ACP_TOOL_CALL_NAME)
    expect((registrations[0] as { meta: { inject: () => { acp: AcpStore } } }).meta.inject()).toEqual({ acp: store })

    stop?.()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('no-ops cleanly on older hosts without tool.call.toolview or throwing slots.inject', () => {
    const store = makeStore()
    const noSlotsCtx = {} as unknown as Context
    const stop1 = installAcpToolView(noSlotsCtx, store)
    expect(() => stop1()).not.toThrow()

    const register = vi.fn(() => () => {})
    const throwingCtx = {
      slots: {
        inject: () => { throw new Error('unknown slot tool.call.toolview') },
        register,
      },
    } as unknown as Context
    const stop2 = installAcpToolView(throwingCtx, store)
    expect(() => stop2()).not.toThrow()
    expect(register).not.toHaveBeenCalled()
  })
})
