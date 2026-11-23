/**
 * The per-agent default chat mode and the settings FORM.
 *
 * The advanced tab's control writes through the lightweight
 * `agent/set-default-mode` RPC, never by editing a draft — but a full save must
 * still carry the current value: `agent/save` rebuilds the definition from the
 * payload, so a field missing from `buildPayload` would silently clear the
 * default. The same field in `payloadEquals` keeps the card from being
 * permanently dirty (which would make every save restart the agent).
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

describe('the per-agent default chat mode in the agent form', () => {
  it('seeds the stored value, and blank when the agent follows its own default', () => {
    expect(initialForm(detected(configWith({ defaultMode: 'strict' })), undefined).defaultMode).toBe('strict')
    expect(initialForm(detected(configWith()), undefined).defaultMode).toBe('')
    expect(initialForm(detected(undefined), undefined).defaultMode).toBe('')
  })

  it('carries the value into agent/save so a full save cannot clear it', () => {
    const config = configWith({ defaultMode: 'strict' })
    const payload = buildPayload(initialForm(detected(config), undefined), detected(config), false)
    expect(payload.defaultMode).toBe('strict')
    expect(validateAgentDef(payload).defaultMode).toBe('strict')
  })

  it('sends no key when the value follows the agent default', () => {
    const config = configWith()
    const payload = buildPayload(initialForm(detected(config), undefined), detected(config), false)
    expect('defaultMode' in payload).toBe(false)
    expect('defaultMode' in validateAgentDef(payload)).toBe(false)
  })

  it('is not dirty on either side of the value', () => {
    for (const extra of [{}, { defaultMode: 'strict' }]) {
      const config = configWith(extra)
      const form = initialForm(detected(config), undefined)
      expect(payloadEquals(buildPayload(form, detected(config), false), config)).toBe(true)
    }
    // A real change IS a difference: the RPC already wrote it, so a stale form
    // (seeded before the write) must be caught rather than saved back.
    const blank = configWith()
    const strict = configWith({ defaultMode: 'strict' })
    expect(payloadEquals(buildPayload(initialForm(detected(blank), undefined), detected(blank), false), strict)).toBe(false)
    expect(payloadEquals(buildPayload(initialForm(detected(strict), undefined), detected(strict), false), blank)).toBe(false)
  })
})
