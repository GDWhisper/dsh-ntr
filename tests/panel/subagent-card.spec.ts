// @vitest-environment jsdom
// The subagent card: gating, the four-rung guidance switch, per-rung notes in
// host tokens, the permission rungs, off-ladder readouts, per-row override
// facts / resets, and the availability facts. The shared panel fixture
// predates `ui/delegate`, so the two routes are answered by a wrapper here
// while every other endpoint keeps the fixture's behavior.
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSettingsSection } from '../../src/client/panel.tsx'
import { AcpStore, type RpcCall } from '../../src/client/store.ts'
import { DELEGATE_DEFAULTS } from '../../src/client/store/settings.ts'
import type { AcpDelegateSettings, DelegateSetPayload, DelegateSettingKey } from '../../src/protocol.ts'
import { createPanelFixture, type PanelRpcCall } from '../panel-fixture.ts'
import { category, click, mountPanel } from './harness.ts'

afterEach(cleanup)

const BASE: AcpDelegateSettings = {
  guidance: 'off', permissionMode: 'auto', timeoutMs: 600_000, maxOutputChars: 20_000,
  toolAvailable: true, restrictAvailable: true,
}

function writes(calls: PanelRpcCall[], endpoint: string): unknown[] {
  return calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
}

/** Reset one key the way the host does: the baseline (config file, else default). */
function resetKey<K extends DelegateSettingKey>(next: AcpDelegateSettings, key: K, baseline: AcpDelegateSettings): void {
  next[key] = baseline[key]
}

async function mountDelegate(seed: AcpDelegateSettings, options: { failWrite?: boolean } = {}) {
  const base = createPanelFixture()
  let current = structuredClone(seed)
  const calls: PanelRpcCall[] = []
  const rpc: RpcCall = async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload: structuredClone(payload) })
    if (channel === '/acp' && endpoint === 'ui/delegate') {
      return { ok: true, value: { delegate: structuredClone(current) } }
    }
    if (channel === '/acp' && endpoint === 'ui/delegate-set') {
      if (options.failWrite === true) return { ok: false, error: { code: 'bad_payload', message: 'no' } }
      const patch = structuredClone(payload) as DelegateSetPayload
      const next: AcpDelegateSettings = {
        ...current,
        ...(patch.guidance === undefined ? {} : { guidance: patch.guidance }),
        ...(patch.permissionMode === undefined ? {} : { permissionMode: patch.permissionMode }),
        ...(patch.timeoutMs === undefined ? {} : { timeoutMs: patch.timeoutMs }),
        ...(patch.maxOutputChars === undefined ? {} : { maxOutputChars: patch.maxOutputChars }),
      }
      const baseline: AcpDelegateSettings = { ...current, ...DELEGATE_DEFAULTS, ...current.configured }
      for (const key of patch.reset ?? []) resetKey(next, key, baseline)
      current = next
      return { ok: true, value: { delegate: structuredClone(current) } }
    }
    return base.rpc(channel, endpoint, payload)
  }
  const store = new AcpStore(rpc, zh => zh)
  await store.resync()
  render(createElement(AcpSettingsSection, { acp: store }))
  return { store, calls }
}

describe('SubagentCard', () => {
  it('hides the page and the nav item on a host without the delegate RPC', async () => {
    await mountPanel()
    const nav = screen.getByRole('navigation', { name: 'NTR 设置分类' })
    expect(within(nav).queryByRole('button', { name: '子代理' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '子代理' })).toBeNull()
    expect(screen.queryByRole('slider', { name: '子代理委派', hidden: true })).toBeNull()
  })

  it('writes the picked guidance rung immediately, optimistically, never as an agent save', async () => {
    const { store, calls } = await mountDelegate(BASE)
    await category('子代理')
    expect(screen.getByRole('heading', { name: '子代理' })).toBeDefined()
    // off/on carry no per-rung note.
    expect(screen.queryByText(/该档位会增强工具描述/)).toBeNull()
    expect(screen.queryByText(/强制模式会屏蔽/)).toBeNull()
    const slider = screen.getByRole('slider', { name: '子代理委派' }) as HTMLInputElement
    expect(slider.value).toBe('0')
    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ guidance: 'on' }]))
    expect(store.getSnapshot().delegate?.guidance).toBe('on')
    expect(screen.getByText('开启', { selector: '.dwa-deadline-value' })).toBeDefined()
    fireEvent.change(slider, { target: { value: '3' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(2))
    expect(writes(calls, 'ui/delegate-set')[1]).toEqual({ guidance: 'force' })
    expect(store.getSnapshot().delegate?.guidance).toBe('force')
    expect(writes(calls, 'agent/save')).toEqual([])
  })

  it('shows the enhanced note in warning tokens', async () => {
    await mountDelegate({ ...BASE, guidance: 'enhanced' })
    await category('子代理')
    const note = screen.getByText('该档位会增强工具描述，引导大模型优先使用本工具。')
    expect(note.className).toContain('dwa-deadline-warn')
    expect(note.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
    expect(note.getAttribute('style')).toContain('--dsw-alias-state-warn-tertiary')
    expect(screen.queryByText(/强制模式会屏蔽/)).toBeNull()
  })

  it('shows the force note in danger tokens', async () => {
    await mountDelegate({ ...BASE, guidance: 'force' })
    await category('子代理')
    const note = screen.getByText('强制模式会屏蔽 DSH 的原生 subagent 能力，请谨慎开启。')
    expect(note.className).toContain('dwa-deadline-warn')
    expect(note.getAttribute('style')).toContain('--dsw-alias-state-error-primary')
    expect(note.getAttribute('style')).toContain('--dsw-alias-interactive-bg-hover-danger')
    expect(screen.queryByText(/该档位会增强工具描述/)).toBeNull()
  })

  it('writes the picked permission rung', async () => {
    const { store, calls } = await mountDelegate(BASE)
    await category('子代理')
    await click(screen.getByRole('button', { name: '直接拒绝' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ permissionMode: 'abort' }]))
    expect(store.getSnapshot().delegate?.permissionMode).toBe('abort')
    expect(screen.getByRole('button', { name: '直接拒绝' }).className).toBe('is-on')
    await click(screen.getByRole('button', { name: '人工确认' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(2))
    expect(writes(calls, 'ui/delegate-set')[1]).toEqual({ permissionMode: 'ask' })
    expect(store.getSnapshot().delegate?.permissionMode).toBe('ask')
  })

  it('writes the picked timeout and cap rungs', async () => {
    const { calls } = await mountDelegate(BASE)
    await category('子代理')
    expect(screen.getByText('10 分钟', { selector: '.dwa-deadline-value' })).toBeDefined()
    expect(screen.getByText('2 万字符', { selector: '.dwa-deadline-value' })).toBeDefined()
    fireEvent.change(screen.getByRole('slider', { name: '单次时限' }), { target: { value: '5' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ timeoutMs: 3_600_000 }]))
    fireEvent.change(screen.getByRole('slider', { name: '返回上限' }), { target: { value: '0' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toHaveLength(2))
    expect(writes(calls, 'ui/delegate-set')[1]).toEqual({ maxOutputChars: 4_000 })
  })

  it('prints an off-ladder value exactly and parks the slider on the nearest rung', async () => {
    await mountDelegate({ ...BASE, timeoutMs: 700_000, maxOutputChars: 12_345 })
    await category('子代理')
    expect(screen.getByText('700 秒', { selector: '.dwa-deadline-value' })).toBeDefined()
    expect((screen.getByRole('slider', { name: '单次时限' }) as HTMLInputElement).value).toBe('2')
    expect(screen.getByText('12345 字符', { selector: '.dwa-deadline-value' })).toBeDefined()
    expect((screen.getByRole('slider', { name: '返回上限' }) as HTMLInputElement).value).toBe('1')
  })

  it('shows the config-file facts and resets only the rows really overridden', async () => {
    const { store, calls } = await mountDelegate({
      ...BASE, guidance: 'force', timeoutMs: 900_000, configured: { guidance: 'on', timeoutMs: 300_000 },
    })
    await category('子代理')
    expect(screen.getByText(/配置文件要求：开启/).className).toContain('dwa-deadline-flag')
    expect(screen.getByText(/配置文件要求：5 分钟/).className).toContain('dwa-deadline-flag')
    const resets = screen.getAllByRole('button', { name: '恢复配置文件的值' })
    expect(resets).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '恢复默认值' })).toBeNull()
    await click(resets[0])
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['guidance'] }]))
    expect(store.getSnapshot().delegate?.guidance).toBe('on')
    expect(screen.queryByText(/配置文件要求：开启/)).toBeNull()
    // The timeout row keeps its own override and its own reset.
    expect(screen.getAllByRole('button', { name: '恢复配置文件的值' })).toHaveLength(1)
    expect(screen.getByText(/配置文件要求：5 分钟/)).toBeDefined()
  })

  it('restores the built-in default when the config file names nothing', async () => {
    const { store, calls } = await mountDelegate({ ...BASE, guidance: 'on' })
    await category('子代理')
    expect(screen.queryByText(/配置文件要求/)).toBeNull()
    await click(screen.getByRole('button', { name: '恢复默认值' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['guidance'] }]))
    expect(store.getSnapshot().delegate?.guidance).toBe('off')
  })

  it('offers no reset when the running value agrees with the baseline', async () => {
    await mountDelegate({ ...BASE, guidance: 'on', configured: { guidance: 'on' } })
    await category('子代理')
    expect(screen.queryByText(/配置文件要求/)).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复默认值' })).toBeNull()
  })

  it('reports a missing tool service as a fact beside the switch', async () => {
    await mountDelegate({ ...BASE, toolAvailable: false })
    await category('子代理')
    expect(screen.getByText(/宿主未提供工具服务，此开关暂不生效/)).toBeDefined()
    expect(screen.queryByText(/宿主未提供工具遮蔽服务/)).toBeNull()
  })

  it('reports the force degradation only while force is picked', async () => {
    await mountDelegate({ ...BASE, guidance: 'force', restrictAvailable: false })
    await category('子代理')
    expect(screen.getByText(/宿主未提供工具遮蔽服务，强制模式暂按引导增强生效/)).toBeDefined()
    cleanup()
    await mountDelegate({ ...BASE, guidance: 'enhanced', restrictAvailable: false })
    await category('子代理')
    expect(screen.queryByText(/宿主未提供工具遮蔽服务/)).toBeNull()
  })

  it('reverts the card to the last host answer when a write is refused', async () => {
    const { store } = await mountDelegate(BASE, { failWrite: true })
    await category('子代理')
    fireEvent.change(screen.getByRole('slider', { name: '子代理委派' }), { target: { value: '2' } })
    await waitFor(() => expect(store.getSnapshot().notice).toBe('no'))
    expect(store.getSnapshot().delegate?.guidance).toBe('off')
    expect(screen.getByText('关闭', { selector: '.dwa-deadline-value' })).toBeDefined()
  })
})