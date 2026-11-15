// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PanelFixture } from '../panel-fixture.ts'
import { click, detail, mountPanel, payloads } from './harness.ts'

afterEach(cleanup)

/**
 * The connection test's failure block.
 *
 * Two mistakes look identical in the host's own error text — the agent is not
 * installed, or the launch command is wrong — so the card has to name the fix
 * and show the evidence it was drawn from.
 */
describe('the connection test result', () => {
  async function openConnection(): Promise<PanelFixture> {
    const fixture = await mountPanel({
      agentTest: {
        ok: false,
        failure: 'not-found',
        command: 'codebuddy',
        error: 'acp: agent "codebuddy" failed to start: ACP connection closed',
        durationMs: 28,
        stderr: ['spawn error: spawn codebuddy ENOENT'],
      },
    })
    await click(screen.getByRole('button', { name: '管理 CodeBuddy' }))
    await detail('连接')
    return fixture
  }

  it('names the fix for a missing agent and shows the stderr behind it', async () => {
    const fixture = await openConnection()
    await click(screen.getByRole('button', { name: '测试连接' }))
    // The hint is the new line; the host's raw sentence stays visible above it.
    await waitFor(() => expect(screen.getByText(/PATH 中找不到「codebuddy」/)).toBeTruthy())
    expect(screen.getByText(/ACP connection closed/)).toBeTruthy()
    // The evidence is not swallowed: this is the only place the ENOENT line
    // can be read (the host returns it, the card used to drop it).
    expect(screen.getByText(/spawn error: spawn codebuddy ENOENT/)).toBeTruthy()
    expect(payloads(fixture, 'agent/test')).toHaveLength(1)
  })
})
