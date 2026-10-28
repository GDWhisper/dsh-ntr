// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, isInaccessible, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSettingsSection } from '../src/client/panel.tsx'
import { createPanelFixture, type PanelFixture, type PanelFixtureOptions, type PanelPermissionRequest } from './panel-fixture.ts'

afterEach(cleanup)

async function mountPanel(options: PanelFixtureOptions = {}): Promise<PanelFixture> {
  const fixture = createPanelFixture(options)
  await fixture.ready
  render(createElement(AcpSettingsSection, { acp: fixture.store }))
  return fixture
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { fireEvent.click(element) })
}

async function category(name: string): Promise<void> {
  await click(within(screen.getByRole('navigation', { name: 'NTR 设置分类' })).getByRole('button', { name }))
}

async function detail(name: string, agent = 'CodeBuddy'): Promise<void> {
  await click(within(screen.getByRole('navigation', { name: `${agent} 配置` })).getByRole('button', { name }))
}

function textbox(name: string): HTMLInputElement {
  return screen.getByRole('textbox', { name }) as HTMLInputElement
}

function payloads(fixture: PanelFixture, endpoint: string): unknown[] {
  return fixture.calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
}

function expectHiddenButMounted(element: HTMLElement): void {
  expect(element.isConnected).toBe(true)
  expect(isInaccessible(element)).toBe(true)
}

function permission(overrides: Partial<PanelPermissionRequest> = {}): PanelPermissionRequest {
  return {
    type: 'permission/request', requestId: 'ask-edit', sessionId: 'acp-preview', dshSessionId: 'other-chat',
    toolCall: { toolCallId: 'edit-1', title: 'Edit project file' },
    toolName: 'Edit project file', reason: 'Update app.ts', timeoutMode: 'wait',
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
    ],
    ...overrides,
  }
}

describe('AcpSettingsSection navigation', () => {
  it('starts with collapsed agents, no creation form, and no model cache read or probe', async () => {
    const fixture = await mountPanel()
    const nav = screen.getByRole('navigation', { name: 'NTR 设置分类' })
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['智能体', '审批时限', '对话外观'])
    expect(within(nav).getByRole('button', { name: '智能体', pressed: true })).toBeDefined()
    expect(screen.getByRole('region', { name: '已接入的智能体' })).toBeDefined()
    expect(screen.getByRole('button', { name: '管理 CodeBuddy', expanded: false })).toBeDefined()
    expect(screen.getByRole('button', { name: '管理 pi', expanded: false })).toBeDefined()
    expect(screen.queryByRole('navigation', { name: 'CodeBuddy 配置' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    // Query the hidden add page explicitly: hidden inputs would still count.
    expect(within(screen.getByLabelText('添加智能体')).queryByRole('textbox', { hidden: true })).toBeNull()
    expect(screen.queryByRole('heading', { name: '审批时限' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '对话外观' })).toBeNull()
    expect(payloads(fixture, 'agent/cached-models')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('shows only the chosen category and keeps the other pages mounted', async () => {
    const fixture = await mountPanel()
    const agents = screen.getByRole('region', { name: '已接入的智能体' })
    await category('审批时限')
    const approvals = screen.getByRole('heading', { name: '审批时限' })
    expectHiddenButMounted(agents)
    expect(screen.queryByRole('button', { name: '管理 CodeBuddy' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '对话外观' })).toBeNull()

    await category('对话外观')
    const appearance = screen.getByRole('region', { name: '对话外观' })
    expectHiddenButMounted(approvals)
    expect(screen.getByRole('button', { name: '呼吸' })).toBeDefined()
    await category('智能体')
    expectHiddenButMounted(appearance)
    expect(screen.getByRole('region', { name: '已接入的智能体' })).toBe(agents)
    expect(payloads(fixture, 'agent/cached-models')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('reads the cache only for an expanded, active model page; navigation never probes', async () => {
    // An empty cache keeps duplicate reads observable.
    const fixture = await mountPanel({ catalogs: { codebuddy: null } })
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    expect(within(screen.getByRole('navigation', { name: 'CodeBuddy 配置' })).getAllByRole('button').map(button => button.textContent))
      .toEqual(['模型', '连接', '高级'])
    expect(payloads(fixture, 'agent/cached-models')).toEqual([{ agentId: 'codebuddy' }])
    await detail('连接')
    await click(screen.getByRole('button', { name: '收起 CodeBuddy' }))
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('高级')
    await category('对话外观')
    await category('智能体')
    expect(payloads(fixture, 'agent/cached-models')).toEqual([{ agentId: 'codebuddy' }])
    await detail('模型')
    expect(payloads(fixture, 'agent/cached-models')).toEqual([{ agentId: 'codebuddy' }, { agentId: 'codebuddy' }])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('distinguishes an unanswered roster from an empty configured roster', async () => {
    let release!: () => void
    const initialResyncGate = new Promise<void>(resolve => { release = resolve })
    const fixture = createPanelFixture({ agents: [], initialResyncGate })
    render(createElement(AcpSettingsSection, { acp: fixture.store }))
    expect(screen.getByRole('status').textContent).toBe('正在读取智能体…')
    expect(screen.queryByRole('heading', { name: '接入第一个智能体' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加智能体' })).toBeNull()
    expect(screen.queryByRole('button', { name: '审批时限' })).toBeNull()

    await act(async () => { release(); await fixture.ready })
    expect(screen.queryByText('正在读取智能体…')).toBeNull()
    expect(screen.getByRole('heading', { name: '接入第一个智能体' })).toBeDefined()
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDefined()
    expect(screen.getByRole('button', { name: '审批时限' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^管理 / })).toBeNull()
    expect(payloads(fixture, 'agent/cached-models')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('omits the approval category on a host without its RPC, without losing permission answers', async () => {
    await mountPanel({ approvalDeadlines: null, permissions: [permission()] })
    const nav = screen.getByRole('navigation', { name: 'NTR 设置分类' })
    expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['智能体', '对话外观'])
    expect(screen.queryByRole('slider', { hidden: true })).toBeNull()
    await category('对话外观')
    expect(screen.getByRole('button', { name: 'Always Allow' })).toBeDefined()
  })

  it('keeps normal preset provenance behind View diagnostics', async () => {
    await mountPanel()
    const source = 'dsh-ntr/presets/acp/acp.patch.yml'
    expect(screen.queryByText(source)).toBeNull()
    expect(screen.queryByText('NTR 模式需要检查，当前可能无法开始对话。')).toBeNull()
    await click(screen.getByRole('button', { name: '查看诊断' }))
    expect(screen.getByRole('heading', { name: '连接诊断' })).toBeDefined()
    expect(isInaccessible(screen.getByText(source))).toBe(false)
    await category('对话外观')
    expect(screen.queryByRole('heading', { name: '连接诊断' })).toBeNull()
    // It may be unmounted or hidden; either way it must not leak into a normal page.
    const provenance = screen.queryByText(source)
    expect(provenance === null || isInaccessible(provenance)).toBe(true)
  })

  it('shows an unusable preset warning globally, not just inside diagnostics', async () => {
    await mountPanel({ preset: { id: 'acp', source: 'broken/acp.patch.yml', installed: false, problem: 'preset composition failed' } })
    for (const name of ['智能体', '审批时限', '对话外观']) {
      await category(name)
      expect(screen.getByRole('status').textContent).toContain('NTR 模式需要检查')
      expect(within(screen.getByRole('status')).getByRole('button', { name: '查看诊断' })).toBeDefined()
      expect(screen.queryByText('broken/acp.patch.yml')).toBeNull()
    }
    await click(within(screen.getByRole('status')).getByRole('button', { name: '查看诊断' }))
    expect(screen.getByText('宿主报告：preset composition failed')).toBeDefined()
  })
})

describe('AcpSettingsSection editing', () => {
  it('preserves connection and partial MCP drafts across detail tabs, categories, and collapse', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    const title = textbox('显示名')
    const command = textbox('启动命令（程序 + 参数）')
    fireEvent.change(title, { target: { value: 'CodeBuddy 本地草稿' } })
    fireEvent.change(command, { target: { value: 'codebuddy --acp --verbose' } })
    await detail('高级')
    const mcp = screen.getByRole('textbox', { name: 'MCP 服务器（JSON）' }) as HTMLTextAreaElement
    const partialJson = '[{"name":"unfinished"'
    fireEvent.change(mcp, { target: { value: partialJson } })
    await detail('模型')
    expectHiddenButMounted(title)
    expectHiddenButMounted(command)
    expectHiddenButMounted(mcp)
    await category('审批时限')
    await category('对话外观')
    await category('智能体')
    await click(screen.getByRole('button', { name: '收起 CodeBuddy' }))
    expectHiddenButMounted(mcp)
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    expect(textbox('显示名')).toBe(title)
    expect(title.value).toBe('CodeBuddy 本地草稿')
    expect(textbox('启动命令（程序 + 参数）')).toBe(command)
    expect(command.value).toBe('codebuddy --acp --verbose')
    await detail('高级')
    expect(screen.getByRole('textbox', { name: 'MCP 服务器（JSON）' })).toBe(mcp)
    expect(mcp.value).toBe(partialJson)
    expect(payloads(fixture, 'agent/save')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('preserves the model search itself when the row or category is hidden', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    const search = textbox('搜索模型')
    fireEvent.change(search, { target: { value: 'sonnet' } })
    await detail('连接')
    expectHiddenButMounted(search)
    await category('对话外观')
    await category('智能体')
    await click(screen.getByRole('button', { name: '收起 CodeBuddy' }))
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('模型')
    expect(textbox('搜索模型')).toBe(search)
    expect(search.value).toBe('sonnet')
    expect(screen.getByRole('button', { name: /Claude Sonnet 4/ })).toBeDefined()
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })

  it('disables unchanged saves and enables Save changes only while the form is dirty', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    const save = screen.getByRole('button', { name: /^保存/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const title = textbox('显示名')
    fireEvent.change(title, { target: { value: 'CodeBuddy 已编辑' } })
    expect((screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(title, { target: { value: 'CodeBuddy' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(title, { target: { value: 'CodeBuddy 已编辑' } })
    await click(screen.getByRole('button', { name: '保存更改' }))
    expect(payloads(fixture, 'agent/save')).toHaveLength(1)
    expect(payloads(fixture, 'agent/save')[0]).toMatchObject({ id: 'codebuddy', title: 'CodeBuddy 已编辑', command: 'codebuddy', args: ['--acp'] })
    expect(screen.getByRole('button', { name: '收起 CodeBuddy 已编辑' })).toBeDefined()
    await act(async () => { await fixture.store.resync() })
    expect(textbox('显示名').value).toBe('CodeBuddy 已编辑')
    expect(save.disabled).toBe(true)
  })

  it('can clear an idle-release override and becomes clean again after saving', async () => {
    const fixture = await mountPanel({ agents: [{
      id: 'codebuddy', title: 'CodeBuddy', command: 'codebuddy', args: ['--acp'],
      cwd: '/workspace/ntr-demo', allowedCwdRoots: ['/workspace/ntr-demo'], idleTimeoutMs: 0,
    }] })
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('高级')
    const save = screen.getByRole('button', { name: '保存更改' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(textbox('空闲释放（毫秒）'), { target: { value: '' } })
    expect(save.disabled).toBe(false)
    await click(save)
    expect(payloads(fixture, 'agent/save')).toHaveLength(1)
    expect(payloads(fixture, 'agent/save')[0]).not.toHaveProperty('idleTimeoutMs')
    await act(async () => { await fixture.store.resync() })
    expect(save.disabled).toBe(true)
  })

  it('mounts Add only on demand, retains its draft on return, then returns to the list after saving', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '添加智能体' }))
    expect(screen.queryByRole('button', { name: '管理 CodeBuddy' })).toBeNull()
    await click(screen.getByRole('button', { name: '自定义' }))
    const id = textbox('Agent ID')
    const title = textbox('显示名')
    const command = textbox('启动命令（程序 + 参数）')
    fireEvent.change(id, { target: { value: 'local-helper' } })
    fireEvent.change(title, { target: { value: '我的本地助手' } })
    fireEvent.change(command, { target: { value: 'local-acp --stdio' } })
    await click(screen.getByRole('button', { name: '返回智能体列表' }))
    expectHiddenButMounted(title)
    expectHiddenButMounted(command)
    expect(screen.getByRole('button', { name: '管理 CodeBuddy' })).toBeDefined()
    await category('对话外观')
    await category('智能体')
    await click(screen.getByRole('button', { name: '添加智能体' }))
    expect(textbox('显示名')).toBe(title)
    expect(title.value).toBe('我的本地助手')
    expect(textbox('启动命令（程序 + 参数）')).toBe(command)
    expect(command.value).toBe('local-acp --stdio')
    expect(id.value).toBe('local-helper')
    expect(payloads(fixture, 'agent/save')).toEqual([])
    await click(screen.getByRole('button', { name: '保存并启用' }))
    expect(payloads(fixture, 'agent/save')).toHaveLength(1)
    expect(payloads(fixture, 'agent/save')[0]).toMatchObject({ id: 'local-helper', title: '我的本地助手', command: 'local-acp', args: ['--stdio'] })
    expect(screen.getByRole('button', { name: '管理 我的本地助手' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '返回智能体列表' })).toBeNull()
    expect(screen.getByRole('region', { name: '已接入的智能体' })).toBeDefined()
  })

  it('persists model selection and auto-discovery only through lightweight RPCs', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await click(screen.getByRole('button', { name: /Claude Sonnet 4/ }))
    await waitFor(() => expect(payloads(fixture, 'agent/set-exposed-models')).toEqual([
      { agentId: 'codebuddy', exposedModels: ['deepseek-v3', 'claude-sonnet-4'] },
    ]))
    await click(screen.getByRole('button', { name: '清空' }))
    await waitFor(() => expect(payloads(fixture, 'agent/set-exposed-models').at(-1)).toEqual({ agentId: 'codebuddy', exposedModels: [] }))
    await click(screen.getByRole('checkbox', { name: '自动发现新模型' }))
    expect(payloads(fixture, 'agent/set-auto-discover-models')).toEqual([{ agentId: 'codebuddy', autoDiscoverModels: false }])
    await act(async () => { await fixture.store.resync() })
    expect((screen.getByRole('checkbox', { name: '自动发现新模型' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: '清空' }) as HTMLButtonElement).disabled).toBe(true)
    expect(payloads(fixture, 'agent/save')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
    expect(payloads(fixture, 'agent/stop')).toEqual([])
  })

  it('persists the plugin default and appearance through their own RPCs', async () => {
    const fixture = await mountPanel()
    await click(screen.getByRole('button', { name: '管理 pi' }))
    await click(screen.getByRole('button', { name: '设为默认智能体' }))
    expect(payloads(fixture, 'default/agent-set')).toEqual([{ agentId: 'pi' }])
    await category('对话外观')
    await click(screen.getByRole('button', { name: '快速' }))
    await click(screen.getByRole('button', { name: '常亮' }))
    expect(payloads(fixture, 'ui/tag-halo-set')).toEqual([
      { halo: { mode: 'breath', speed: 'fast' } }, { halo: { mode: 'steady', speed: 'fast' } },
    ])
    await act(async () => { await fixture.store.resync() })
    expect(fixture.store.getSnapshot().defaultAgent).toBe('pi')
    expect(fixture.store.getSnapshot().tagHalo).toEqual({ mode: 'steady', speed: 'fast' })
    expect(screen.queryByRole('button', { name: '快速' })).toBeNull()
    expect(payloads(fixture, 'agent/save')).toEqual([])
    expect(payloads(fixture, 'agent/probe-models')).toEqual([])
  })
})

describe('AcpSettingsSection permissions', () => {
  it.each(['智能体', '审批时限', '对话外观', '添加智能体'])('answers verbatim permission options and cancels independently from %s', async page => {
    const fixture = await mountPanel()
    if (page === '添加智能体') await click(screen.getByRole('button', { name: page }))
    else await category(page)
    await act(async () => { await fixture.applyEvent(permission()) })
    expect(screen.getByText('Edit project file')).toBeDefined()
    const optionNames = screen.getAllByRole('button').map(button => button.textContent)
      .filter(name => ['Allow once', 'Always Allow', 'Reject once'].includes(name ?? ''))
    expect(optionNames).toEqual(['Allow once', 'Always Allow', 'Reject once'])
    await click(screen.getByRole('button', { name: 'Always Allow' }))
    expect(payloads(fixture, 'permission/respond')).toEqual([{ requestId: 'ask-edit', optionId: 'always' }])
    expect(screen.queryByRole('button', { name: 'Always Allow' })).toBeNull()

    // An RPC-only ask has no conversation identity, but must still be answerable.
    await act(async () => { await fixture.applyEvent(permission({ requestId: 'ask-cancel', dshSessionId: undefined })) })
    await category(page === '对话外观' ? '智能体' : '对话外观')
    expect(screen.getByRole('button', { name: 'Reject once' })).toBeDefined()
    // Independent cancellation must not select the agent's rejection option.
    await click(screen.getByRole('button', { name: '取消' }))
    expect(payloads(fixture, 'permission/respond')).toEqual([
      { requestId: 'ask-edit', optionId: 'always' }, { requestId: 'ask-cancel' },
    ])
    expect(screen.queryByText('待处理权限请求')).toBeNull()
  })

  it('draws no slider for default wait, offers zero for auto, and starts abort at a real wait', async () => {
    const fixture = await mountPanel()
    await category('审批时限')
    expect(screen.getByRole('button', { name: '一直等待' })).toBeDefined()
    expect(screen.queryByRole('slider', { hidden: true })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
    expect(payloads(fixture, 'ui/approval-deadlines-set')).toEqual([])

    await click(screen.getByRole('button', { name: '自动推进' }))
    let slider = screen.getByRole('slider', { name: '等待时长' }) as HTMLInputElement
    await act(async () => { fireEvent.change(slider, { target: { value: slider.min } }) })
    expect(payloads(fixture, 'ui/approval-deadlines-set')).toEqual([{ mode: 'auto' }, { permissionTimeoutMs: 0 }])
    expect(screen.getAllByText('不等待').length).toBeGreaterThan(0)
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'auto', permissionTimeoutMs: 0 })

    await click(screen.getByRole('button', { name: '超时中止' }))
    expect(screen.queryByText('不等待')).toBeNull()
    slider = screen.getByRole('slider', { name: '等待时长' }) as HTMLInputElement
    expect(slider.value).toBe(slider.min)
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'abort', permissionTimeoutMs: 30_000 })
    // Move away and back to exercise the abort ladder's first selectable value.
    await act(async () => { fireEvent.change(slider, { target: { value: slider.max } }) })
    await act(async () => { fireEvent.change(slider, { target: { value: slider.min } }) })
    expect(payloads(fixture, 'ui/approval-deadlines-set').slice(2)).toEqual([
      { mode: 'abort' }, { permissionTimeoutMs: 21_600_000 }, { permissionTimeoutMs: 30_000 },
    ])
    await click(screen.getByRole('button', { name: '一直等待' }))
    expect(screen.queryByRole('slider', { hidden: true })).toBeNull()
    expect(payloads(fixture, 'ui/approval-deadlines-set').at(-1)).toEqual({ mode: 'wait' })
  })

  it('resets a real approval override to the host baseline', async () => {
    const fixture = await mountPanel({ approvalDeadlines: {
      mode: 'auto', permissionTimeoutMs: 0, configuredMode: 'wait', configured: { permissionTimeoutMs: 300_000 },
    } })
    await category('审批时限')
    await click(screen.getByRole('button', { name: '恢复配置文件的值' }))
    expect(payloads(fixture, 'ui/approval-deadlines-set')).toEqual([{ reset: true }])
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
    expect(screen.queryByRole('slider', { hidden: true })).toBeNull()
    await act(async () => { await fixture.store.resync() })
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'wait', permissionTimeoutMs: 300_000 })
  })
})
