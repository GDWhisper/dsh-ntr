// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { category, click, mountPanel, payloads, permission } from './harness.ts'

afterEach(cleanup)

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
    expect(screen.queryByRole('slider', { name: '等待时长', hidden: true })).toBeNull()
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
    // Tick labels sit on the exact rung fractions (abort ladder: 7 rungs).
    expect(screen.getByText('15 分钟', { selector: '.dwa-deadline-ticks span' }).style.left).toBe('50%')
    // Switching back must restore the ZERO, not keep the abort floor: a mode
    // write carries no window, and the host keeps the user's raw pick.
    await click(screen.getByRole('button', { name: '自动推进' }))
    expect(screen.getAllByText('不等待').length).toBeGreaterThan(0)
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'auto', permissionTimeoutMs: 0 })
    // The first four writes are plain actions: the two mode switches carry no
    // duration, and the slider write carries no mode.
    expect(payloads(fixture, 'ui/approval-deadlines-set').slice(0, 4)).toEqual([
      { mode: 'auto' }, { permissionTimeoutMs: 0 }, { mode: 'abort' }, { mode: 'auto' },
    ])
    // Move away and back to exercise the abort ladder's first selectable value.
    await click(screen.getByRole('button', { name: '超时中止' }))
    slider = screen.getByRole('slider', { name: '等待时长' }) as HTMLInputElement
    await act(async () => { fireEvent.change(slider, { target: { value: slider.max } }) })
    await act(async () => { fireEvent.change(slider, { target: { value: slider.min } }) })
    expect(payloads(fixture, 'ui/approval-deadlines-set').slice(4)).toEqual([
      { mode: 'abort' }, { permissionTimeoutMs: 21_600_000 }, { permissionTimeoutMs: 30_000 },
    ])
    await click(screen.getByRole('button', { name: '一直等待' }))
    expect(screen.queryByRole('slider', { name: '等待时长', hidden: true })).toBeNull()
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
    expect(screen.queryByRole('slider', { name: '等待时长', hidden: true })).toBeNull()
    await act(async () => { await fixture.store.resync() })
    expect(fixture.store.getSnapshot().approvalDeadlines).toMatchObject({ mode: 'wait', permissionTimeoutMs: 300_000 })
  })
})
