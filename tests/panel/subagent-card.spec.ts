// @vitest-environment jsdom
// The subagent card: gating, the four-rung guidance switch, per-rung hints
// and notes in host tokens, the hand-filled minute timeout input (no permission
// row, no ladder), off-grid readouts, per-row override facts, a reset that
// appears only when the window really overrides the baseline (an older host
// half reporting no baseline gets no reset — the mixed-version guard), and the
// availability facts. The shared panel fixture predates `ui/delegate`, so the
// two routes are answered by a wrapper here while every other endpoint keeps
// the fixture's behavior.
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpSettingsSection } from '../../src/client/panel.tsx'
import { AcpStore, type RpcCall } from '../../src/client/store.ts'
import type { AcpDelegateSettings, DelegateSetPayload } from '../../src/protocol.ts'
import { createPanelFixture, type PanelRpcCall } from '../panel-fixture.ts'
import { category, click, expandCard, mountPanel } from './harness.ts'

afterEach(cleanup)

const BASE: AcpDelegateSettings = {
  guidance: 'off', timeoutMs: 2_400_000, defaultTimeoutMs: 2_400_000,
  toolAvailable: true, restrictAvailable: true,
}

function writes(calls: PanelRpcCall[], endpoint: string): unknown[] {
  return calls.filter(call => call.endpoint === endpoint).map(call => call.payload)
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
      let next: AcpDelegateSettings = {
        ...current,
        ...(patch.guidance === undefined ? {} : { guidance: patch.guidance }),
        ...(patch.timeoutMs === undefined ? {} : { timeoutMs: patch.timeoutMs }),
        ...(patch.defaultAgent === undefined ? {} : { defaultAgent: patch.defaultAgent }),
      }
      if (patch.agentDefaults !== undefined) {
        const merged = { ...(current.agentDefaults ?? {}) }
        for (const [id, entry] of Object.entries(patch.agentDefaults)) {
          if (entry === null) delete merged[id]
          else merged[id] = entry
        }
        next = { ...next, agentDefaults: merged }
      }
      // A reset returns to the configured baseline, else the host default.
      for (const key of patch.reset ?? []) {
        if (key === 'timeoutMs') next = { ...next, timeoutMs: current.configured?.timeoutMs ?? current.defaultTimeoutMs ?? next.timeoutMs }
        if (key === 'guidance') next = { ...next, guidance: current.configured?.guidance ?? 'off' }
        if (key === 'defaultAgent') next = { ...next, defaultAgent: current.configured?.defaultAgent }
        if (key === 'agentDefaults') next = { ...next, agentDefaults: current.configured?.agentDefaults ?? {} }
      }
      // Host view hygiene (delegateSettingsView): an empty map is NO key.
      if (next.agentDefaults !== undefined && Object.keys(next.agentDefaults).length === 0) {
        next = { ...next }
        delete next.agentDefaults
      }
      next = { ...next, resolvedDefaultAgent: next.defaultAgent ?? next.globalDefaultAgent }
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
    expect(within(nav).queryByRole('button', { name: '子智能体' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '子智能体' })).toBeNull()
    expect(screen.queryByRole('slider', { name: '子智能体委派', hidden: true })).toBeNull()
  })

  it('writes the picked guidance rung immediately, optimistically, never as an agent save', async () => {
    const { store, calls } = await mountDelegate(BASE)
    await category('子智能体')
    expect(screen.getByRole('heading', { name: '子智能体' })).toBeDefined()
    // off/on carry no enhanced/force warning text; their banners are checked below.
    expect(screen.queryByText(/该档位会增强工具描述/)).toBeNull()
    expect(screen.queryByText(/强制模式会屏蔽/)).toBeNull()
    const slider = screen.getByRole('slider', { name: '子智能体委派' }) as HTMLInputElement
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
    await category('子智能体')
    const note = screen.getByText('该档位会增强工具描述，引导大模型优先使用本工具。')
    // The warn tone is the box's DEFAULT: no modifier, so the stylesheet's own
    // warn pair is what it wears.
    expect(note.className).toBe('dwa-deadline-warn')
    expect(screen.queryByText(/强制模式会屏蔽/)).toBeNull()
  })

  it('shows the force note in danger tokens', async () => {
    await mountDelegate({ ...BASE, guidance: 'force' })
    await category('子智能体')
    const note = screen.getByText('强制模式会屏蔽 DSH 的原生 subagent 能力，请谨慎开启。')
    expect(note.className).toContain('dwa-deadline-warn')
    expect(note.className).toContain('is-danger')
    expect(screen.queryByText(/该档位会增强工具描述/)).toBeNull()
  })

  it('injects one whole stylesheet, never a string cut short by a stray delimiter', async () => {
    await mountDelegate(BASE)
    const style = [...document.head.querySelectorAll('style')]
      .map(node => node.textContent ?? '')
      .find(text => text.includes('.dwa-deadline-warn')) ?? ''
    // STYLE is a template literal, so a stray backtick or a `${` splits it into
    // two halves that are each still valid TypeScript — the loss is silent. The
    // first and last rules plus balanced braces are the cheapest proof that the
    // whole sheet is in the document, not just its head.
    expect(style).toContain('.dwa-root {')
    expect(style).toContain('prefers-reduced-motion: reduce')
    expect((style.match(/\{/g) ?? []).length).toBe((style.match(/\}/g) ?? []).length)
  })

  it('shows the off hint as a neutral banner and the on hint as a success banner', async () => {
    await mountDelegate(BASE)
    await category('子智能体')
    const offHint = screen.getByText('子智能体功能关闭，当前NTR不作为原生dsh的子智能体工具')
    expect(offHint.className).toContain('dwa-deadline-warn')
    expect(offHint.className).toContain('is-neutral')
    expect(screen.queryByText(/关闭 = 不注册本工具/)).toBeNull()
    fireEvent.change(screen.getByRole('slider', { name: '子智能体委派' }), { target: { value: '1' } })
    const onHint = await screen.findByText('NTR将作为子智能体工具注册进原生dsh会话中，下一轮对话生效')
    expect(onHint.className).toContain('dwa-deadline-warn')
    expect(onHint.className).toContain('is-success')
    expect(screen.queryByText('子智能体功能关闭，当前NTR不作为原生dsh的子智能体工具')).toBeNull()
    expect(screen.queryByText(/关闭 = 不注册本工具/)).toBeNull()
  })

  it('declares every note tone with host alias tokens, never a literal', async () => {
    // The tones moved out of inline styles and into the stylesheet, so the
    // token fact is asserted where it is written. jsdom does not resolve CSS
    // custom properties, so the rule text is the evidence.
    await mountDelegate({ ...BASE, guidance: 'force' })
    const style = [...document.head.querySelectorAll('style')]
      .map(node => node.textContent ?? '')
      .find(text => text.includes('.dwa-deadline-warn')) ?? ''
    const rule = (selector: string): string => {
      const start = style.indexOf(selector)
      expect(start).toBeGreaterThan(-1)
      return style.slice(start, style.indexOf('}', start))
    }
    // Default warn pair, then the three modifiers.
    expect(rule('.dwa-deadline-warn {')).toContain('--dsw-alias-state-warn-tertiary')
    expect(rule('.dwa-deadline-warn.is-neutral')).toContain('--dsw-alias-bg-layer-2')
    expect(rule('.dwa-deadline-warn.is-success')).toContain('--dsw-alias-state-success-tertiary')
    expect(rule('.dwa-deadline-warn.is-danger')).toContain('--dsw-alias-interactive-bg-hover-danger')
  })

  it('removes the ladder sentence on every rung, keeping only the warn boxes', async () => {
    await mountDelegate({ ...BASE, guidance: 'enhanced' })
    await category('子智能体')
    expect(screen.queryByText(/关闭 = 不注册本工具/)).toBeNull()
    expect(screen.queryByText(/子智能体功能关闭/)).toBeNull()
    expect(screen.queryByText(/NTR将作为子智能体工具注册/)).toBeNull()
    expect(screen.getByText('该档位会增强工具描述，引导大模型优先使用本工具。')).toBeDefined()
    cleanup()
    await mountDelegate({ ...BASE, guidance: 'force' })
    await category('子智能体')
    expect(screen.queryByText(/关闭 = 不注册本工具/)).toBeNull()
    expect(screen.getByText('强制模式会屏蔽 DSH 的原生 subagent 能力，请谨慎开启。')).toBeDefined()
  })

  it('centers the guidance tick labels on the exact rung fractions', async () => {
    await mountDelegate(BASE)
    await category('子智能体')
    const guidanceLefts = ['关闭', '开启', '引导增强', '强制模式'].map(name =>
      Number.parseFloat(screen.getByText(name, { selector: '.dwa-deadline-ticks span' }).style.left))
    expect(guidanceLefts[0]).toBe(0)
    expect(guidanceLefts[1]).toBeCloseTo(100 / 3, 6)
    expect(guidanceLefts[2]).toBeCloseTo(200 / 3, 6)
    expect(guidanceLefts[3]).toBe(100)
  })

  it('renders no permission row — the delegation policy is always auto', async () => {
    await mountDelegate(BASE)
    await category('子智能体')
    expect(screen.queryByRole('button', { name: '自动代答' })).toBeNull()
    expect(screen.queryByRole('button', { name: '直接拒绝' })).toBeNull()
    expect(screen.queryByRole('button', { name: '人工确认' })).toBeNull()
    expect(screen.queryByText('权限', { selector: '.dwa-preference-label' })).toBeNull()
    expect(screen.queryByText(/委派期间的审批请求如何作答/)).toBeNull()
  })

  it('writes a hand-filled minute value as round(minutes*60000)', async () => {
    const { calls } = await mountDelegate(BASE)
    await category('子智能体')
    const input = screen.getByRole('spinbutton', { name: '单次时限' }) as HTMLInputElement
    // The display value is the exact ms/60000 with no trailing zeros.
    expect(input.value).toBe('40')
    fireEvent.change(input, { target: { value: '90' } })
    fireEvent.blur(input)
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ timeoutMs: 5_400_000 }]))
  })

  it('commits a hand-filled minute value on Enter as round(minutes*60000)', async () => {
    const { calls } = await mountDelegate(BASE)
    await category('子智能体')
    const input = screen.getByRole('spinbutton', { name: '单次时限' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '90' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ timeoutMs: 5_400_000 }]))
  })

  it('snaps an empty, non-numeric or out-of-range draft back on blur, without writing', async () => {
    const { calls } = await mountDelegate(BASE)
    await category('子智能体')
    const input = screen.getByRole('spinbutton', { name: '单次时限' }) as HTMLInputElement
    // 0 minutes → 0 ms (below the 1 s floor); 1500 minutes → 25 h (above the 24 h ceiling).
    for (const bad of ['', 'abc', '0', '1500']) {
      fireEvent.change(input, { target: { value: bad } })
      fireEvent.blur(input)
      // The draft returns to the exact value in force (40 minutes); no RPC fires.
      await waitFor(() => expect(input.value).toBe('40'))
    }
    expect(writes(calls, 'ui/delegate-set')).toEqual([])
  })

  it('prints an off-grid window exactly, with no slider to round it', async () => {
    await mountDelegate({ ...BASE, timeoutMs: 700_000 })
    await category('子智能体')
    expect(screen.getByText('700 秒', { selector: '.dwa-deadline-value' })).toBeDefined()
    expect(screen.queryByRole('slider', { name: '单次时限' })).toBeNull()
  })

  it('shows the config-file facts on the rows really overridden, with a reset back to the file value', async () => {
    const { calls } = await mountDelegate({
      ...BASE, guidance: 'force', timeoutMs: 900_000, defaultTimeoutMs: 300_000,
      configured: { guidance: 'on', timeoutMs: 300_000 },
    })
    await category('子智能体')
    expect(screen.getByText(/配置文件要求：开启/).className).toContain('dwa-deadline-flag')
    expect(screen.getByText(/配置文件要求：5 分钟/).className).toContain('dwa-deadline-flag')
    // The window overrides the baseline → a reset labelled to the config value appears.
    await click(screen.getByRole('button', { name: '恢复配置文件的值' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['timeoutMs'] }]))
  })

  it('offers no reset button and no override facts when nothing is overridden', async () => {
    await mountDelegate({ ...BASE, guidance: 'on', configured: { guidance: 'on' } })
    await category('子智能体')
    expect(screen.queryByText(/配置文件要求/)).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复默认值' })).toBeNull()
  })

  it('resetting the window restores the baseline and hides the reset button', async () => {
    const { store, calls } = await mountDelegate({ ...BASE, timeoutMs: 5_400_000 })
    await category('子智能体')
    expect(screen.getByText('90 分钟', { selector: '.dwa-deadline-value' })).toBeDefined()
    await click(screen.getByRole('button', { name: '恢复默认值' }))
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ reset: ['timeoutMs'] }]))
    expect(store.getSnapshot().delegate?.timeoutMs).toBe(2_400_000)
    await waitFor(() => expect(screen.queryByRole('button', { name: '恢复默认值' })).toBeNull())
  })

  it('offers no reset on an older host half that reports no defaultTimeoutMs (mixed-version guard)', async () => {
    // The old half reports the running window but no baseline: the card must
    // not invent one, so no reset appears even though the value looks changed.
    await mountDelegate({ guidance: 'off', timeoutMs: 5_400_000, toolAvailable: true, restrictAvailable: true })
    await category('子智能体')
    expect(screen.getByText('90 分钟', { selector: '.dwa-deadline-value' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '恢复默认值' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复配置文件的值' })).toBeNull()
  })

  it('reports a missing tool service as a fact beside the switch', async () => {
    await mountDelegate({ ...BASE, toolAvailable: false })
    await category('子智能体')
    expect(screen.getByText(/宿主未提供工具服务，此开关暂不生效/)).toBeDefined()
    expect(screen.queryByText(/宿主未提供工具遮蔽服务/)).toBeNull()
  })

  it('shows no missing-service warning while off on a capable host', async () => {
    await mountDelegate({ ...BASE, guidance: 'off', toolAvailable: true })
    await category('子智能体')
    expect(screen.queryByText(/宿主未提供工具服务/)).toBeNull()
  })

  it('reports the force degradation only while force is picked', async () => {
    await mountDelegate({ ...BASE, guidance: 'force', restrictAvailable: false })
    await category('子智能体')
    expect(screen.getByText(/宿主未提供工具遮蔽服务，强制模式暂按引导增强生效/)).toBeDefined()
    cleanup()
    await mountDelegate({ ...BASE, guidance: 'enhanced', restrictAvailable: false })
    await category('子智能体')
    expect(screen.queryByText(/宿主未提供工具遮蔽服务/)).toBeNull()
  })

  it('reverts the card to the last host answer when a write is refused', async () => {
    const { store } = await mountDelegate(BASE, { failWrite: true })
    await category('子智能体')
    fireEvent.change(screen.getByRole('slider', { name: '子智能体委派' }), { target: { value: '2' } })
    await waitFor(() => expect(store.getSnapshot().notice).toBe('no'))
    expect(store.getSnapshot().delegate?.guidance).toBe('off')
    expect(screen.getByText('关闭', { selector: '.dwa-deadline-value' })).toBeDefined()
  })

  it('mounts the delegation-defaults section and writes a per-agent default through the card', async () => {
    const { store, calls } = await mountDelegate({ ...BASE, globalDefaultAgent: 'codebuddy', resolvedDefaultAgent: 'codebuddy' })
    await category('子智能体')
    expect(screen.getByText('子智能体委派配置')).toBeDefined()
    expect((screen.getByRole('combobox', { name: '默认子智能体' }) as HTMLSelectElement).value).toBe('')
    // The cards arrive folded; the axes are behind this agent's own head.
    await expandCard('codebuddy')
    const model = screen.getByRole('combobox', { name: '模型 · CodeBuddy' }) as HTMLSelectElement
    await waitFor(() => expect(Array.from(model.options).map(option => option.value)).toContain('claude-sonnet-4'))
    fireEvent.change(model, { target: { value: 'claude-sonnet-4' } })
    await waitFor(() => expect(writes(calls, 'ui/delegate-set')).toEqual([{ agentDefaults: { codebuddy: { model: 'claude-sonnet-4' } } }]))
    expect(store.getSnapshot().delegate?.agentDefaults?.codebuddy).toEqual({ model: 'claude-sonnet-4' })
    expect(writes(calls, 'agent/save')).toEqual([])
  })
})