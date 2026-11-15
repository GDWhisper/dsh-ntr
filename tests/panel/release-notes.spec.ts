// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { click, mountPanel, payloads } from './harness.ts'

afterEach(cleanup)

describe('AcpSettingsSection release notes', () => {
  // Deliberately NOT the URL `pluginReleaseUrl()` derives: the card must show
  // the page the host reported, not a rebuilt one.
  const NOTES_URL = 'https://example.test/releases/v9.9.9'
  const notes = {
    version: '9.9.9',
    url: NOTES_URL,
    body: '## 新增\n\n- 一条中文发布说明\n\n---\n\n## Added\n\n- one English release note',
    source: 'github' as const,
  }

  it('previews the offered version in Chinese and names the release page', async () => {
    const fixture = await mountPanel({
      pluginUpdate: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' },
      pluginReleaseNotes: notes,
    })
    // Nothing is read before the card is opened.
    expect(payloads(fixture, 'plugin/release-notes')).toEqual([])
    await click(await screen.findByRole('button', { name: '可更新 v9.9.9' }))
    expect(await screen.findByText('一条中文发布说明')).toBeDefined()
    expect(screen.queryByText('one English release note')).toBeNull()
    expect(screen.getByRole('heading', { level: 4, name: '新增' })).toBeDefined()
    expect(screen.getByText('发布说明 v9.9.9')).toBeDefined()
    const page = screen.getByRole('link', { name: NOTES_URL })
    expect(page.getAttribute('href')).toBe(NOTES_URL)
    expect(page.getAttribute('target')).toBe('_blank')
    expect(payloads(fixture, 'plugin/release-notes')).toEqual([{ version: '9.9.9' }])
  })

  it('previews the English half under an English locale', async () => {
    await mountPanel({
      locale: (_zh, en) => en,
      pluginUpdate: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' },
      pluginReleaseNotes: notes,
    })
    await click(await screen.findByRole('button', { name: 'Update v9.9.9' }))
    expect(await screen.findByText('one English release note')).toBeDefined()
    expect(screen.queryByText('一条中文发布说明')).toBeNull()
    expect(screen.getByText('Release notes v9.9.9')).toBeDefined()
    expect(screen.getByRole('link', { name: NOTES_URL })).toBeDefined()
  })

  it('still shows the release page on a host without the endpoint', async () => {
    const fixture = await mountPanel({
      pluginUpdate: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' },
    })
    await click(await screen.findByRole('button', { name: '可更新 v9.9.9' }))
    expect(await screen.findByText('发布说明暂不可用。')).toBeDefined()
    const derived = 'https://github.com/GDWhisper/dsh-ntr/releases/tag/v9.9.9'
    expect(screen.getByRole('link', { name: derived }).getAttribute('href')).toBe(derived)
    expect(payloads(fixture, 'plugin/release-notes')).toEqual([{ version: '9.9.9' }])
    // An endpoint that does not exist cannot be retried into working.
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    // A missing body is a normal degradation, not an error banner.
    expect(fixture.store.getSnapshot().notice).toBeUndefined()
  })

  it('retries a real failure with a host refresh', async () => {
    const fixture = await mountPanel({
      pluginUpdate: { status: 'available', current: '0.2.1', installed: '0.2.1', latest: '9.9.9' },
      pluginReleaseNotes: {
        version: '9.9.9',
        url: NOTES_URL,
        source: 'none',
        message: 'github: github answered 502; changelog: jsdelivr answered 502',
      },
    })
    await click(await screen.findByRole('button', { name: '可更新 v9.9.9' }))
    await screen.findByText('发布说明暂不可用。')
    await click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(payloads(fixture, 'plugin/release-notes')).toEqual([
      { version: '9.9.9' },
      { version: '9.9.9', refresh: true },
    ]))
  })

  it('previews the running version when the plugin is up to date', async () => {
    const fixture = await mountPanel({
      pluginReleaseNotes: {
        version: '0.2.1',
        url: 'https://github.com/GDWhisper/dsh-ntr/releases/tag/v0.2.1',
        body: '## 新增\n\n- 当前版本说明',
        source: 'changelog',
      },
    })
    await click(await screen.findByRole('button', { name: 'v0.2.1' }))
    expect(await screen.findByText('当前版本说明')).toBeDefined()
    expect(screen.getByText('发布说明 v0.2.1')).toBeDefined()
    expect(payloads(fixture, 'plugin/release-notes')).toEqual([{ version: '0.2.1' }])
  })

  it('draws no release notes for a source install', async () => {
    const fixture = await mountPanel({
      pluginUpdate: { status: 'source-install', current: '0.2.1', installed: '0.2.1' },
      pluginReleaseNotes: notes,
    })
    await click(await screen.findByRole('button', { name: 'v0.2.1' }))
    expect(document.querySelector('.dwa-update-notes')).toBeNull()
    expect(payloads(fixture, 'plugin/release-notes')).toEqual([])
  })
})
