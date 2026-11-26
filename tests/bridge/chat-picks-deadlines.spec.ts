import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentBridge, BridgeManager } from '../../src/bridge.ts'
import { EventHub } from '../../src/impl.ts'
import { def } from './harness.ts'

describe('approval deadline persistence (isolated manager)', () => {
  const pickHub = new EventHub()

  it('edits an approval deadline live, persists it, and resets to the config file', async () => {
    const storage = `${tmpdir()}/acp-deadlines-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    // Nothing configured, nothing overridden: the built-in 5-minute window and
    // the default mode.
    expect(gm.approvalDeadlines()).toEqual({ permissionTimeoutMs: 300_000, elicitationTimeoutMs: 300_000, mode: 'wait', questionTimeoutMode: 'cancel' })
    // A deployment that names the window in `cordis.patch.yml` reports it as
    // the reset target — "the file says 10 minutes" and "nothing was
    // configured, 5 is the built-in default" are different facts, and the
    // settings card has to be able to tell them apart.
    gm.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000, elicitationTimeoutMs: 900_000 }, 'wait')
    expect(gm.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 600_000,
      elicitationTimeoutMs: 900_000,
      mode: 'wait',
      configured: { permissionTimeoutMs: 600_000, elicitationTimeoutMs: 900_000 },
      configuredMode: 'wait',
    })

    // The UI write outranks the config file and reaches the LIVE bridge without
    // restarting anything — the whole point over an `agent/save`-style reload,
    // which would cost the user every running session.
    const tuningOf = (b: AgentBridge): { permissionTimeoutMs: number; elicitationTimeoutMs: number } =>
      b as unknown as { permissionTimeoutMs: number; elicitationTimeoutMs: number }
    const liveBridge = new AgentBridge({ ...def, id: 'live' }, pickHub, 500, () => { /* no manager behind it */ })
    ;(gm as unknown as { bridges: Map<string, AgentBridge> }).bridges.set('live', liveBridge)
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 30_000, elicitationTimeoutMs: 0, mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 30_000,
      elicitationTimeoutMs: 0,
      mode: 'auto',
      configured: { permissionTimeoutMs: 600_000, elicitationTimeoutMs: 900_000 },
      configuredMode: 'wait',
    })
    expect(tuningOf(liveBridge).permissionTimeoutMs).toBe(30_000)
    expect(tuningOf(liveBridge).elicitationTimeoutMs).toBe(0)
    // The mode reaches the live bridge too — it decides what an expiry DOES.
    expect((liveBridge as unknown as { permissionTimeoutMode: string }).permissionTimeoutMode).toBe('auto')

    // Persisted: a host restart comes back on the value the user picked, not the
    // deployment baseline. The host entry re-declares the patch file's baseline
    // on every boot, so the override has to keep outranking it after a restart.
    const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    reloaded.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000, elicitationTimeoutMs: 900_000 }, 'wait')
    expect(reloaded.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 30_000,
      elicitationTimeoutMs: 0,
      mode: 'auto',
      configured: { permissionTimeoutMs: 600_000, elicitationTimeoutMs: 900_000 },
    })

    // Reset drops the override: the config file decides again.
    await reloaded.setApprovalDeadlines({}, true)
    expect(reloaded.approvalDeadlines()).toMatchObject({
      permissionTimeoutMs: 600_000,
      elicitationTimeoutMs: 900_000,
      mode: 'wait',
    })
    // A fresh manager over the same file sees the same thing (the reset persisted).
    const afterReset = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    afterReset.setConfiguredApprovalDeadlines({ permissionTimeoutMs: 600_000, elicitationTimeoutMs: 900_000 }, 'wait')
    expect(afterReset.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 600_000, elicitationTimeoutMs: 900_000, mode: 'wait' })

    // An out-of-range write is refused before it can reach state, and the value
    // in force is untouched.
    await expect(reloaded.setApprovalDeadlines({ permissionTimeoutMs: -1 })).rejects.toThrow(/permissionTimeoutMs/)
    await expect(reloaded.setApprovalDeadlines({ elicitationTimeoutMs: -1 })).rejects.toThrow(/elicitationTimeoutMs/)
    expect(reloaded.approvalDeadlines().permissionTimeoutMs).toBe(600_000)
    // A mode that is not one of the three is refused the same way.
    await expect(reloaded.setApprovalDeadlines({ mode: 'maybe' as never })).rejects.toThrow(/permissionTimeoutMode/)
    expect(reloaded.approvalDeadlines().mode).toBe('wait')

    await afterReset.shutdownAll()
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  interface PersistedDeadlines {
    approvalDeadlines?: { permissionTimeoutMs?: number; elicitationTimeoutMs?: number; mode?: string; questionTimeoutMode?: string }
  }

    const readDeadlines = (storage: string): PersistedDeadlines['approvalDeadlines'] =>
      (JSON.parse(readFileSync(storage, 'utf-8')) as PersistedDeadlines).approvalDeadlines

  it('persists the form-question window exactly as picked, including no deadline', async () => {
    const storage = `${tmpdir()}/acp-elicitation-deadline-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    await gm.setApprovalDeadlines({ elicitationTimeoutMs: 0 })
    expect(readDeadlines(storage)).toEqual({ elicitationTimeoutMs: 0 })
    const reloaded = new BridgeManager([{ ...def, id: 'picked' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ elicitationTimeoutMs: 0 })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('keeps a user-picked zero through a mode switch and a restart', async () => {
    const storage = `${tmpdir()}/acp-deadline-zero-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'zero' }], pickHub, 500, storage)
    // 不等待 is the user's pick: it runs as zero under `auto`.
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    // A mode-only write carries no window: the stored zero survives, while the
    // RUNTIME value floors to the shortest real wait under `abort`.
    await gm.setApprovalDeadlines({ mode: 'abort' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'abort' })
    // Switching back restores the zero — because the write never rewrote it.
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    // A restart reads the same raw zero back, and the runtime agrees.
    const reloaded = new BridgeManager([{ ...def, id: 'zero' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('keeps a real window unchanged through every mode switch', async () => {
    const storage = `${tmpdir()}/acp-deadline-real-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'real' }], pickHub, 500, storage)
    await gm.setApprovalDeadlines({ permissionTimeoutMs: 300_000, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'auto' })
    await gm.setApprovalDeadlines({ mode: 'abort' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'abort' })
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 300_000, mode: 'auto' })
    const reloaded = new BridgeManager([{ ...def, id: 'real' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 300_000, mode: 'auto' })
    await reloaded.shutdownAll()
    await gm.shutdownAll()
  })

  it('floors a persisted zero under abort at runtime only', async () => {
    // A state file can hold any pair the user or an older build wrote. The
    // zero must NOT become 「不等待并立即拒绝」: under `abort` it runs as the
    // 30 s minimum, and the file stays what the user chose.
    const storage = `${tmpdir()}/acp-deadline-legacy-zero-${Date.now()}.json`
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 0, mode: 'abort' },
    }), 'utf-8')
    const gm = new BridgeManager([{ ...def, id: 'legacy-zero' }], pickHub, 500, storage)
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'abort' })
    await gm.shutdownAll()
  })

  it('reads the persisted zero back raw at boot, so a mode switch can restore it', async () => {
    // Startup must not rewrite the stored pick with the abort floor. If the
    // load path normalized it, the runtime would read the same 30 s as the
    // fixed logic and nothing below could fail — so this case asserts BOTH
    // halves: the runtime floor at boot, and the raw zero still being the
    // value a later switch back to `auto` runs on (the file included).
    const storage = `${tmpdir()}/acp-deadline-boot-zero-${Date.now()}.json`
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 0, mode: 'abort' },
    }), 'utf-8')
    const gm = new BridgeManager([{ ...def, id: 'boot-zero' }], pickHub, 500, storage)
    // Boot applies the abort floor to the RUNTIME value only.
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 30_000, mode: 'abort' })
    // Switching back to `auto` recovers 不等待 from the stored value, not from
    // a boot-time rewrite of it.
    await gm.setApprovalDeadlines({ mode: 'auto' })
    expect(gm.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    expect(readDeadlines(storage)).toEqual({ permissionTimeoutMs: 0, mode: 'auto' })
    await gm.shutdownAll()
    // A second boot over the same file agrees, so the guard also covers
    // reading a value the restart itself wrote.
    const reloaded = new BridgeManager([{ ...def, id: 'boot-zero' }], pickHub, 500, storage)
    expect(reloaded.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 0, mode: 'auto' })
    await reloaded.shutdownAll()
  })

  it('persists questionTimeoutMode only when `first`, pushes hot to live bridges, and tolerates per-key corruption', async () => {
    const storage = `${tmpdir()}/acp-question-mode-${Date.now()}.json`
    const gm = new BridgeManager([{ ...def, id: 'qmode' }], pickHub, 500, storage)
    const liveBridge = new AgentBridge({ ...def, id: 'live-q' }, pickHub, 500, () => {})
    ;(gm as unknown as { bridges: Map<string, AgentBridge> }).bridges.set('live-q', liveBridge)

    await gm.setApprovalDeadlines({ questionTimeoutMode: 'first' })
    expect(gm.approvalDeadlines().questionTimeoutMode).toBe('first')
    expect(readDeadlines(storage)).toEqual({ questionTimeoutMode: 'first' })
    expect((liveBridge as unknown as { questionTimeoutMode: string }).questionTimeoutMode).toBe('first')

    // Returning to the default `cancel` omits the key from disk instead of writing a phantom override.
    await gm.setApprovalDeadlines({ questionTimeoutMode: 'cancel' })
    expect(gm.approvalDeadlines().questionTimeoutMode).toBe('cancel')
    expect(readDeadlines(storage)).toBeUndefined()
    expect((liveBridge as unknown as { questionTimeoutMode: string }).questionTimeoutMode).toBe('cancel')

    // `reset` restores `cancel` too.
    await gm.setApprovalDeadlines({ questionTimeoutMode: 'first' })
    await gm.setApprovalDeadlines({}, true)
    expect(gm.approvalDeadlines().questionTimeoutMode).toBe('cancel')
    expect(readDeadlines(storage)).toBeUndefined()
    await gm.shutdownAll()

    // Corrupt `questionTimeoutMode` drops ONLY that key; sibling windows survive reboot.
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 60_000, elicitationTimeoutMs: 0, questionTimeoutMode: 'bogus' },
    }), 'utf-8')
    const tolerateQ = new BridgeManager([{ ...def, id: 'qmode' }], pickHub, 500, storage)
    expect(tolerateQ.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 60_000, elicitationTimeoutMs: 0, questionTimeoutMode: 'cancel' })
    await tolerateQ.shutdownAll()

    // Corrupt `mode` drops ONLY `mode`; valid `questionTimeoutMode: 'first'` survives reboot.
    writeFileSync(storage, JSON.stringify({
      version: 2,
      approvalDeadlines: { permissionTimeoutMs: 60_000, mode: 'bogus', questionTimeoutMode: 'first' },
    }), 'utf-8')
    const tolerateMode = new BridgeManager([{ ...def, id: 'qmode' }], pickHub, 500, storage)
    expect(tolerateMode.approvalDeadlines()).toMatchObject({ permissionTimeoutMs: 60_000, mode: 'wait', questionTimeoutMode: 'first' })
    await tolerateMode.shutdownAll()
  })

})
