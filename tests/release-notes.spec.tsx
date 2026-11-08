// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpStore } from '../src/client/store.ts'
import { ReleaseNotesSection, pickReleaseLanguage, releaseNoteVersion } from '../src/client/release-notes.tsx'
import type { PluginReleaseNotes, PluginUpdateState } from '../src/protocol.ts'

afterEach(cleanup)

const RELEASE_URL = 'https://github.com/GDWhisper/dsh-ntr/releases/tag/v9.9.9'

const BILINGUAL = [
  '## 新增',
  '',
  '- **acp**：一条净改动。([abc1234](https://github.com/GDWhisper/dsh-ntr/commit/abc1234))',
  '- 行内 `code` 也照原样',
  '',
  '---',
  '',
  '## Added',
  '',
  '- **acp**: a net change. ([abc1234](https://github.com/GDWhisper/dsh-ntr/commit/abc1234))',
].join('\n')

function state(patch: Partial<PluginUpdateState> = {}): PluginUpdateState {
  return { status: 'current', current: '1.0.0', ...patch }
}

function notes(overrides: Partial<PluginReleaseNotes> = {}): PluginReleaseNotes {
  return { version: '9.9.9', url: RELEASE_URL, body: BILINGUAL, source: 'github', ...overrides }
}

/**
 * A store whose only answered endpoint is `plugin/release-notes`; `notes: null`
 * makes it answer `unknown endpoint`, the way an older host half does.
 */
function createStore(options: { zh?: boolean; notes?: PluginReleaseNotes | null; gate?: Promise<void> } = {}) {
  const zh = options.zh ?? true
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const store = new AcpStore(async (_channel, endpoint, payload) => {
    if (endpoint === 'plugin/release-notes') {
      calls.push({ endpoint, payload })
      if (options.gate !== undefined) await options.gate
      if (options.notes === null) {
        return { ok: false, error: { code: 'unsupported', message: 'unknown endpoint plugin/release-notes' } }
      }
      return { ok: true, value: options.notes ?? notes() }
    }
    return { ok: false, error: { code: 'unsupported', message: `unknown endpoint ${endpoint}` } }
  }, (zhText, enText) => (zh ? zhText : enText))
  return { store, calls }
}

async function mount(options: {
  update: PluginUpdateState
  zh?: boolean
  notes?: PluginReleaseNotes | null
}): Promise<Array<{ endpoint: string; payload: unknown }>> {
  const fixture = createStore({ zh: options.zh ?? true, notes: options.notes })
  render(createElement(ReleaseNotesSection, { acp: fixture.store, update: options.update }))
  return fixture.calls
}

describe('pickReleaseLanguage', () => {
  it('picks the half a bilingual body separates with ---', () => {
    const body = '中文版\n\n## 新增\n\n- 一条\n\n---\n\nEnglish\n\n## Added\n\n- one'
    expect(pickReleaseLanguage(body, true)).toBe('中文版\n\n## 新增\n\n- 一条')
    expect(pickReleaseLanguage(body, false)).toBe('English\n\n## Added\n\n- one')
  })

  it('allows spaces around the separator and CRLF line endings', () => {
    expect(pickReleaseLanguage('中文\r\n   ---   \r\nEnglish', true)).toBe('中文')
    expect(pickReleaseLanguage('中文\r\n   ---   \r\nEnglish', false)).toBe('English')
  })

  it('returns the whole body when there is no separator', () => {
    expect(pickReleaseLanguage('  only one half  ', true)).toBe('only one half')
    expect(pickReleaseLanguage('  only one half  ', false)).toBe('only one half')
  })

  it('returns the whole body when there are more halves than two', () => {
    const body = 'a\n\n---\n\nb\n\n---\n\nc'
    expect(pickReleaseLanguage(body, true)).toBe(body)
    expect(pickReleaseLanguage(body, false)).toBe(body)
  })

  it('does not treat a line with other content as a separator', () => {
    expect(pickReleaseLanguage('a\n---b\nc', true)).toBe('a\n---b\nc')
  })

  it('trims blank lines around the chosen half', () => {
    expect(pickReleaseLanguage('\n\n中文\n\n---\n\nEnglish\n\n', true)).toBe('中文')
    expect(pickReleaseLanguage('\n\n中文\n\n---\n\nEnglish\n\n', false)).toBe('English')
  })
})

describe('releaseNoteVersion', () => {
  it('names the offered version for available and applying', () => {
    expect(releaseNoteVersion(state({ status: 'available', latest: '9.9.9', installed: '8.8.8' }))).toBe('9.9.9')
    expect(releaseNoteVersion(state({ status: 'available', installed: '8.8.8' }))).toBe('8.8.8')
    expect(releaseNoteVersion(state({ status: 'applying', latest: '9.9.9', installed: '8.8.8' }))).toBe('9.9.9')
    expect(releaseNoteVersion(state({ status: 'applying', installed: '8.8.8' }))).toBe('8.8.8')
    expect(releaseNoteVersion(state({ status: 'applying' }))).toBeUndefined()
  })

  it('names the disk version for applied and restart-required', () => {
    expect(releaseNoteVersion(state({ status: 'applied', installed: '8.8.8', latest: '9.9.9' }))).toBe('8.8.8')
    expect(releaseNoteVersion(state({ status: 'applied', latest: '9.9.9' }))).toBe('9.9.9')
    expect(releaseNoteVersion(state({ status: 'restart-required', installed: '8.8.8', latest: '9.9.9' }))).toBe('8.8.8')
    expect(releaseNoteVersion(state({ status: 'restart-required', latest: '9.9.9' }))).toBe('9.9.9')
  })

  it('names latest, else the running version, when up to date', () => {
    expect(releaseNoteVersion(state({ status: 'current', latest: '9.9.9', current: '1.1.1' }))).toBe('9.9.9')
    expect(releaseNoteVersion(state({ status: 'current', current: '1.1.1' }))).toBe('1.1.1')
  })

  it('names the target for failed and busy, and nothing without one', () => {
    expect(releaseNoteVersion(state({ status: 'failed', latest: '9.9.9' }))).toBe('9.9.9')
    expect(releaseNoteVersion(state({ status: 'busy', latest: '9.9.9' }))).toBe('9.9.9')
    expect(releaseNoteVersion(state({ status: 'failed' }))).toBeUndefined()
    expect(releaseNoteVersion(state({ status: 'busy' }))).toBeUndefined()
  })

  it('describes no version for installs this card cannot update', () => {
    for (const status of ['unsupported', 'not-installed', 'source-install', 'managed'] as const) {
      expect(releaseNoteVersion(state({ status, latest: '9.9.9' }))).toBeUndefined()
    }
  })
})

describe('ReleaseNotesSection', () => {
  it('draws the Chinese half and the release page for a Chinese UI', async () => {
    const calls = await mount({ update: state({ status: 'available', latest: '9.9.9' }), zh: true })
    expect(await screen.findByRole('heading', { level: 4, name: '新增' })).toBeDefined()
    expect(screen.queryByRole('heading', { level: 4, name: 'Added' })).toBeNull()
    expect(screen.getByText('发布说明 v9.9.9')).toBeDefined()
    expect(screen.getByText('acp')).toBeDefined()
    expect(screen.getByText('code').tagName).toBe('CODE')
    expect(screen.getByRole('link', { name: 'abc1234' }).getAttribute('href'))
      .toBe('https://github.com/GDWhisper/dsh-ntr/commit/abc1234')
    const page = screen.getByRole('link', { name: RELEASE_URL })
    expect(page.getAttribute('href')).toBe(RELEASE_URL)
    expect(page.getAttribute('target')).toBe('_blank')
    expect(page.getAttribute('rel')).toBe('noreferrer noopener')
    expect(screen.getByText('发布页：')).toBeDefined()
    expect(calls).toEqual([{ endpoint: 'plugin/release-notes', payload: { version: '9.9.9' } }])
  })

  it('draws the English half for an English UI', async () => {
    await mount({ update: state({ status: 'available', latest: '9.9.9' }), zh: false })
    expect(await screen.findByRole('heading', { level: 4, name: 'Added' })).toBeDefined()
    expect(screen.queryByRole('heading', { level: 4, name: '新增' })).toBeNull()
    expect(screen.getByText('Release notes v9.9.9')).toBeDefined()
    expect(screen.getByText(/Release page:/)).toBeDefined()
    expect(screen.getByRole('link', { name: RELEASE_URL })).toBeDefined()
  })

  it('renders a list and an h4 heading from the body', async () => {
    await mount({ update: state({ status: 'available', latest: '9.9.9' }) })
    const list = await screen.findByRole('list')
    expect(list.querySelectorAll('li')).toHaveLength(2)
  })

  it('keeps a non-http(s) link as literal text', async () => {
    await mount({
      update: state({ status: 'available', latest: '9.9.9' }),
      notes: notes({ body: '[click](javascript:alert)' }),
    })
    await waitFor(() => expect(screen.queryByText('正在加载发布说明…')).toBeNull())
    expect(screen.queryByRole('link', { name: 'click' })).toBeNull()
    expect(screen.getByText('[click](javascript:alert)')).toBeDefined()
    // The release page itself is still a real link.
    expect(screen.getByRole('link', { name: RELEASE_URL })).toBeDefined()
  })

  it('renders HTML-looking body text as literal characters', async () => {
    const hostile = '<img src=x onerror="alert(1)">'
    await mount({
      update: state({ status: 'available', latest: '9.9.9' }),
      notes: notes({ body: hostile }),
    })
    expect(await screen.findByText(hostile)).toBeDefined()
    expect(document.querySelector('img')).toBeNull()
  })

  it('keeps the release page and says so when only the page is known', async () => {
    await mount({ update: state({ status: 'available', latest: '9.9.9' }), notes: null })
    expect(await screen.findByText('发布说明暂不可用。')).toBeDefined()
    expect(screen.getByRole('link', { name: RELEASE_URL }).getAttribute('href')).toBe(RELEASE_URL)
  })

  it('offers no retry for an older host: there is nothing to retry', async () => {
    await mount({ update: state({ status: 'available', latest: '9.9.9' }), notes: null })
    await screen.findByText('发布说明暂不可用。')
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('retries a real failure and asks the host to refresh its cache', async () => {
    const calls = await mount({
      update: state({ status: 'available', latest: '9.9.9' }),
      notes: notes({ body: undefined, source: 'none', message: 'github: github answered 404; changelog: jsdelivr answered 404' }),
    })
    await screen.findByText('发布说明暂不可用。')
    expect(calls).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toEqual({ endpoint: 'plugin/release-notes', payload: { version: '9.9.9', refresh: true } })
  })

  it('shows the loading line before any answer arrives', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fixture = createStore({ gate })
    render(createElement(ReleaseNotesSection, {
      acp: fixture.store,
      update: state({ status: 'available', latest: '9.9.9' }),
    }))
    // The first frame must not claim the notes are unavailable.
    expect(screen.getByText('正在加载发布说明…')).toBeDefined()
    expect(screen.queryByText('发布说明暂不可用。')).toBeNull()
    await act(async () => { release() })
    expect(await screen.findByRole('heading', { level: 4, name: '新增' })).toBeDefined()
  })

  it('loads the current version too', async () => {
    const calls = await mount({ update: state({ status: 'current', latest: '0.2.1', current: '0.2.1' }) })
    expect(await screen.findByText('发布说明 v0.2.1')).toBeDefined()
    expect(calls).toEqual([{ endpoint: 'plugin/release-notes', payload: { version: '0.2.1' } }])
  })

  it('draws no section for a source install', async () => {
    const calls = await mount({ update: state({ status: 'source-install', current: '0.2.1' }) })
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('.dwa-update-notes')).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('AcpStore.loadPluginReleaseNotes', () => {
  it('answers the derivable release page when the host has no endpoint', async () => {
    const { store } = createStore({ notes: null })
    expect(await store.loadPluginReleaseNotes('9.9.9')).toEqual({
      version: '9.9.9',
      url: RELEASE_URL,
      source: 'none',
    })
    expect(store.getSnapshot().notice).toBeUndefined()
  })

  it('reads one version once and reuses the answer', async () => {
    const { store, calls } = createStore()
    await store.loadPluginReleaseNotes('9.9.9')
    await store.loadPluginReleaseNotes('9.9.9')
    expect(calls).toHaveLength(1)
    await store.loadPluginReleaseNotes('9.9.9', true)
    expect(calls).toHaveLength(2)
  })

  it('dedupes two concurrent reads of the same version', async () => {
    const { store, calls } = createStore()
    await Promise.all([store.loadPluginReleaseNotes('9.9.9'), store.loadPluginReleaseNotes('9.9.9')])
    expect(calls).toHaveLength(1)
  })

  it('drops a non-string body and a non-http page', async () => {
    const { store } = createStore({
      notes: {
        version: '9.9.9',
        url: 'javascript:alert(1)',
        source: 'github',
        body: 42 as unknown as string,
      },
    })
    expect(await store.loadPluginReleaseNotes('9.9.9')).toEqual({
      version: '9.9.9',
      url: RELEASE_URL,
      source: 'github',
    })
  })

  it('reuses a body-less answer for only one minute', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-08T00:00:00Z'))
      const { store, calls } = createStore({ notes: null })
      await store.loadPluginReleaseNotes('9.9.9')
      vi.setSystemTime(new Date('2026-11-08T00:00:30Z'))
      await store.loadPluginReleaseNotes('9.9.9')
      expect(calls).toHaveLength(1)
      vi.setSystemTime(new Date('2026-11-08T00:01:01Z'))
      await store.loadPluginReleaseNotes('9.9.9')
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
