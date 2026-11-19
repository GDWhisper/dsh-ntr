import { describe, expect, it, vi } from 'vitest'
import { AcpDelegateForceMask, DELEGATE_FORCE_DENY_CANDIDATES } from '../../src/bridge/delegate-force-mask.ts'

/**
 * Force-rung per-agent masking (§5.4 / §7.3): intersection deny through each
 * agent's own scoped tools face, lifecycle follow, full teardown on clear.
 */

const NATIVE_DELEGATION = ['subagent', 'subagent_fork', 'workflow']
const CONTROL_PLANE = ['list_agents', 'send_message', 'wait_agent']

function fakeAgent(id: string, visible: string[], restrictThrows = false) {
  const state = { visible: [...visible], denyCalls: [] as string[][], disposerCalls: 0 }
  const agent = {
    id,
    ctx: {
      tools: {
        get: (name: string) => (state.visible.includes(name) ? { name } : undefined),
        restrict: (filter: { deny: string[] }) => {
          if (restrictThrows) throw new Error('unknown tool name in deny list')
          for (const name of filter.deny) if (!state.visible.includes(name)) throw new Error(`unknown tool ${name}`)
          state.denyCalls.push([...filter.deny])
          // The mask hides the denied names; the disposer restores them.
          state.visible = state.visible.filter(name => !filter.deny.includes(name))
          return () => {
            state.disposerCalls += 1
            state.visible.push(...filter.deny)
          }
        },
      },
    },
  }
  return { agent, state }
}

function fakeCtx(roster: Array<{ id: string }>, opts: { agents?: boolean; restrict?: boolean } = {}) {
  const listeners: Record<string, Array<(payload: { agent?: unknown }) => void>> = {}
  const ctx = {
    get: (name: string) => {
      if (name === 'agents' && opts.agents !== false) return { list: () => roster, get: (id: string) => roster.find(a => a.id === id) }
      if (name === 'tools' && opts.restrict !== false) return { restrict: () => () => {} }
      return undefined
    },
    on: (event: string, listener: (payload: { agent?: unknown }) => void) => {
      (listeners[event] ??= []).push(listener)
      return () => {
        const array = listeners[event]
        const index = array.indexOf(listener)
        if (index >= 0) array.splice(index, 1)
      }
    },
  }
  return {
    ctx,
    emit: (event: string, agent: unknown) => { for (const listener of [...(listeners[event] ?? [])]) listener({ agent }) },
    listenerCount: (event: string) => (listeners[event] ?? []).length,
  }
}

describe('acp_delegate force mask', () => {
  it('masks all three native delegation tools on a standard agent, keeps the control plane', () => {
    const standard = fakeAgent('std', [...NATIVE_DELEGATION, ...CONTROL_PLANE])
    const ntr = fakeAgent('ntr', ['dsh_ntr__acp_tool_call'])
    const { ctx } = fakeCtx([standard.agent, ntr.agent])
    const mask = new AcpDelegateForceMask({ ctx })
    expect(mask.available).toBe(true)
    expect(DELEGATE_FORCE_DENY_CANDIDATES).toEqual(NATIVE_DELEGATION)
    mask.apply()
    expect(standard.state.denyCalls).toEqual([NATIVE_DELEGATION])
    for (const name of NATIVE_DELEGATION) expect(standard.agent.ctx.tools.get(name)).toBeUndefined()
    for (const name of CONTROL_PLANE) expect(standard.agent.ctx.tools.get(name)).toBeDefined()
    // NTR: empty intersection → skipped silently, no restrict, no throw.
    expect(ntr.state.denyCalls).toEqual([])
    // Idempotent: a second apply never restricts an already-masked agent.
    mask.apply()
    expect(standard.state.denyCalls).toHaveLength(1)
  })

  it('applies the same intersection rule to agents created later', () => {
    const { ctx, emit } = fakeCtx([])
    const mask = new AcpDelegateForceMask({ ctx })
    mask.apply()
    const late = fakeAgent('late', [...NATIVE_DELEGATION])
    emit('agent/created', late.agent)
    expect(late.state.denyCalls).toEqual([NATIVE_DELEGATION])
    const lateNtr = fakeAgent('late-ntr', [])
    emit('agent/created', lateNtr.agent)
    expect(lateNtr.state.denyCalls).toEqual([])
  })

  it('agent/disposed clears the table entry; clear() only calls the surviving disposers', () => {
    const a = fakeAgent('a', [...NATIVE_DELEGATION])
    const b = fakeAgent('b', [...NATIVE_DELEGATION])
    const { ctx, emit } = fakeCtx([a.agent, b.agent])
    const mask = new AcpDelegateForceMask({ ctx })
    mask.apply()
    emit('agent/disposed', a.agent) // the scoped restrict unwound with the agent ctx
    mask.clear()
    expect(a.state.disposerCalls).toBe(0)
    expect(b.state.disposerCalls).toBe(1)
  })

  it('clear() lifts every mask, unsubscribes, and stays idempotent; re-apply masks again', () => {
    const a = fakeAgent('a', [...NATIVE_DELEGATION])
    const b = fakeAgent('b', [...NATIVE_DELEGATION])
    const harness = fakeCtx([a.agent, b.agent])
    const mask = new AcpDelegateForceMask({ ctx: harness.ctx })
    mask.apply()
    expect(harness.listenerCount('agent/created')).toBe(1)
    mask.clear()
    mask.clear()
    expect(a.state.disposerCalls).toBe(1)
    expect(b.state.disposerCalls).toBe(1)
    expect(harness.listenerCount('agent/created')).toBe(0)
    const late = fakeAgent('late', [...NATIVE_DELEGATION])
    harness.emit('agent/created', late.agent)
    expect(late.state.denyCalls).toEqual([]) // no listener left after clear
    mask.apply()
    expect(a.state.denyCalls).toHaveLength(2)
    expect(b.state.denyCalls).toHaveLength(2)
  })

  it('a throwing restrict notifies once and continues with the remaining agents', () => {
    const broken = fakeAgent('broken', [...NATIVE_DELEGATION], true)
    const healthy = fakeAgent('healthy', [...NATIVE_DELEGATION])
    const { ctx } = fakeCtx([broken.agent, healthy.agent])
    const notify = vi.fn()
    const mask = new AcpDelegateForceMask({ ctx, notify })
    expect(() => mask.apply()).not.toThrow()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('broken')
    expect(healthy.state.denyCalls).toEqual([NATIVE_DELEGATION])
  })

  it('available=false (no agents service or no restrict) makes apply a silent no-op', () => {
    const standard = fakeAgent('std', [...NATIVE_DELEGATION])
    for (const opts of [{ agents: false }, { restrict: false }]) {
      const { ctx } = fakeCtx([standard.agent], opts)
      const mask = new AcpDelegateForceMask({ ctx })
      expect(mask.available).toBe(false)
      expect(() => mask.apply()).not.toThrow()
      expect(standard.state.denyCalls).toEqual([])
      expect(() => mask.clear()).not.toThrow()
    }
  })
})