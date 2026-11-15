/**
 * The per-agent `dsh-skills` switch and the settings FORM.
 *
 * The agent card toggles it through the lightweight `agent/set-skills-mcp` RPC,
 * never by editing a draft — but a full save must still carry the current value:
 * `agent/save` rebuilds the definition from the payload, so a field missing from
 * `buildPayload` would silently re-enable the built-in server for an agent that
 * opted out. The same field in `payloadEquals` keeps the card from being
 * permanently dirty (which would make every save restart the agent).
 *
 * Spec: docs/plan/dsh-skills-mcp.md §13.3.
 */
import { describe, expect, it } from 'vitest'
import { buildPayload, initialForm, payloadEquals } from '../src/client/panel/form.ts'
import { validateAgentDef } from '../src/impl/validate.ts'
import type { AcpAgentDef, DetectedAgentInfo } from '../src/protocol.ts'

function detected(config: AcpAgentDef | undefined): DetectedAgentInfo {
  return {
    id: 'pi',
    name: 'pi',
    detected: true,
    defaultCommand: 'pi-acp',
    defaultArgs: [],
    currentConfig: config,
  }
}

function configWith(extra: Partial<AcpAgentDef> = {}): AcpAgentDef {
  return { id: 'pi', title: 'pi', command: 'pi-acp', args: [], env: {}, allowedCwdRoots: [], ...extra }
}

describe('the per-agent dsh-skills switch in the agent form', () => {
  it('seeds an agent that never opted out as ON, and an opted-out one as OFF', () => {
    expect(initialForm(detected(configWith()), undefined).skillsMcpEnabled).toBe(true)
    expect(initialForm(detected(configWith({ skillsMcpEnabled: false })), undefined).skillsMcpEnabled).toBe(false)
    // A new / custom agent has no stored config at all: the default is on, the
    // same answer the host gives for the absent field.
    expect(initialForm(detected(undefined), undefined).skillsMcpEnabled).toBe(true)
  })

  it('carries the opt-out into agent/save so a full save cannot re-enable it', () => {
    const config = configWith({ skillsMcpEnabled: false })
    const payload = buildPayload(initialForm(detected(config), undefined), detected(config), false)
    expect(payload.skillsMcpEnabled).toBe(false)
    // The host validates the payload and REBUILDS the definition from it: that
    // round trip is what `agent/save` writes, so it is what must keep the field.
    expect(validateAgentDef(payload).skillsMcpEnabled).toBe(false)
  })

  it('sends no key for an agent that is on (the file stores only the opt-out)', () => {
    const config = configWith()
    const payload = buildPayload(initialForm(detected(config), undefined), detected(config), false)
    expect('skillsMcpEnabled' in payload).toBe(false)
    expect('skillsMcpEnabled' in validateAgentDef(payload)).toBe(false)
  })

  it('is not dirty on either side of the switch', () => {
    for (const extra of [{}, { skillsMcpEnabled: false }]) {
      const config = configWith(extra)
      const form = initialForm(detected(config), undefined)
      expect(payloadEquals(buildPayload(form, detected(config), false), config)).toBe(true)
    }
    // A real flip IS a change: the RPC already wrote it, so a stale form (one
    // seeded before the toggle landed) must be caught rather than saved back.
    const onConfig = configWith()
    const offConfig = configWith({ skillsMcpEnabled: false })
    expect(payloadEquals(buildPayload(initialForm(detected(onConfig), undefined), detected(onConfig), false), offConfig)).toBe(false)
    expect(payloadEquals(buildPayload(initialForm(detected(offConfig), undefined), detected(offConfig), false), onConfig)).toBe(false)
  })
})
