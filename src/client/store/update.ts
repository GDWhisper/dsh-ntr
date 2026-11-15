/**
 * The built-in updater's browser half, lifted out of `AcpStore` (split plan
 * P3b): the throttled `plugin/update-check` read, the explicit
 * `plugin/update-apply` install and the per-version `plugin/release-notes`
 * preview.
 *
 * All three are cached here, not in `UiState`: the throttle windows, the shared
 * in-flight reads and the apply generation guard only decide which host answer
 * may land. What a surface renders still travels through
 * {@link UpdateHost.mutate}, so the notification timing is the facade's.
 *
 * The service never imports the facade; the RPC face, the snapshot, the label
 * resolver and the notice writer arrive through {@link UpdateHost}.
 */

import type { PluginReleaseNotes, PluginUpdateState } from '../../protocol.ts'
import { pluginReleaseUrl } from '../../protocol.ts'
import type { UiState } from './state.ts'

/** How long one version's release notes are reused before asking the host again. */
const PLUGIN_RELEASE_NOTES_TTL_MS = 10 * 60 * 1000
/** A body-less answer is retried sooner: the next open may hit a working GitHub. */
const PLUGIN_RELEASE_NOTES_FAILURE_TTL_MS = 60 * 1000
/**
 * How long a fetched update state stays fresh. The settings panel asks on every
 * mount; without this, every open would hit the registry. A forced check (the
 * card's own button) always goes out.
 */
const PLUGIN_UPDATE_TTL_MS = 10 * 60 * 1000

/** What the update service needs from the store, injected. */
export interface UpdateHost {
  /** The `/acp` RPC face (the store's own `call`, code-preserving errors included). */
  call<T>(endpoint: string, payload?: unknown): Promise<T>
  /** Commit one snapshot patch and notify listeners — the store's single writer. */
  mutate(patch: Partial<UiState>): void
  /** The current snapshot (reads only). */
  state(): UiState
  /** The store's locale-bound label resolver (a stable reference across renders). */
  label(zh: string, en: string): string
}

export class UpdateService {
  /** When {@link UiState.pluginUpdate} was last read from the host (epoch ms). */
  private fetchedAt = 0
  /**
   * The shared in-flight `plugin/update-check`. The settings section mounts
   * twice (both entries) and the update popover asks too; without this, two
   * mounts in the same tick each fire their own registry read.
   */
  private inflight?: Promise<PluginUpdateState | undefined>
  /** Re-entry guard for `plugin/update-apply` (a double click is one install). */
  private applying = false
  /**
   * Update read generation. An apply bumps it so a check that was already in
   * flight (started before the install) cannot land afterwards and overwrite
   * the install's verdict with the pre-install `available`.
   */
  private generation = 0
  /** One version's release notes, so reopening the card does not re-read GitHub. */
  private readonly releaseNotesCache = new Map<string, { at: number; notes: PluginReleaseNotes }>()
  /** Shared in-flight `plugin/release-notes` reads, keyed by version. */
  private readonly releaseNotesInflight = new Map<string, Promise<PluginReleaseNotes | undefined>>()

  constructor(private readonly host: UpdateHost) {}

  /**
   * Read the plugin's update state (`plugin/update-check`). Throttled to ten
   * minutes unless `force`: the settings panel asks on mount, and every
   * remount must not hit the registry.
   *
   * An older host serves no such endpoint (`unknown endpoint`). That is a
   * normal degradation, not an error worth a notice: the answer is `undefined`
   * and the panel simply keeps its update entry hidden.
   */
  async checkPluginUpdate(force = false): Promise<PluginUpdateState | undefined> {
    // One read for every caller while it is in flight, force included: the
    // settings page and the popover mounting together must not hit the
    // registry twice.
    if (this.inflight !== undefined) return this.inflight
    const current = this.host.state().pluginUpdate
    if (!force && current !== undefined && Date.now() - this.fetchedAt < PLUGIN_UPDATE_TTL_MS) {
      return current
    }
    const generation = this.generation
    const inflight = this.readPluginUpdate(generation)
    this.inflight = inflight
    try {
      return await inflight
    } finally {
      this.inflight = undefined
    }
  }

  private async readPluginUpdate(generation: number): Promise<PluginUpdateState | undefined> {
    try {
      const pluginUpdate = await this.host.call<PluginUpdateState>('plugin/update-check')
      // An install started while this read was in flight: its answer is
      // already stale, and the install's verdict owns the state now.
      if (generation !== this.generation) return undefined
      this.fetchedAt = Date.now()
      this.host.mutate({ pluginUpdate })
      return pluginUpdate
    } catch {
      return undefined
    }
  }

  /**
   * Install one exact version (`plugin/update-apply`). The status flips to
   * `applying` first so the badge answers the click; the host's answer then
   * becomes the state.
   *
   * A failed call does NOT prove the install did not happen: on an HMR host
   * the update uninstalls the plugin before reinstalling it, which can cut the
   * response. Whatever the error, the disk may already carry the new version,
   * so the state becomes `restart-required` (the one neutral verdict for "the
   * running code is not the disk's") with `installed` dropped (unknown, not a
   * fact to display) and the notice asks for a reload rather than restoring
   * `available` and pretending nothing changed.
   */
  async applyPluginUpdate(version: string): Promise<PluginUpdateState | undefined> {
    if (this.applying) return undefined
    this.applying = true
    // Any check already in flight predates the install; its answer must not
    // land on top of the install's verdict.
    this.generation += 1
    const previous = this.host.state().pluginUpdate
    if (previous !== undefined) {
      this.host.mutate({ pluginUpdate: { ...previous, status: 'applying' } })
    }
    try {
      const pluginUpdate = await this.host.call<PluginUpdateState>('plugin/update-apply', { version })
      this.fetchedAt = Date.now()
      this.host.mutate({ pluginUpdate })
      return pluginUpdate
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The disk state is UNKNOWN here: the install may have completed before
      // the response was cut. Keep `latest` for display, drop `installed` so no
      // surface can claim a disk version we never read, and reset the throttle
      // so the next check actually asks the host instead of serving this
      // unknown verdict for ten minutes.
      const interrupted: PluginUpdateState = previous !== undefined
        ? { ...previous, status: 'restart-required', installed: undefined, message }
        : { status: 'restart-required', current: this.host.state().pluginVersion ?? '?', message }
      this.fetchedAt = 0
      this.host.mutate({
        pluginUpdate: interrupted,
        notice: this.host.label(
          '更新请求已中断；请刷新页面确认当前版本。',
          'The update request was interrupted. Reload the page to confirm the installed version.',
        ),
      })
      return undefined
    } finally {
      // Invalidate reads that STARTED during the install: their "applying"
      // answer would otherwise land on top of this call's final verdict.
      this.generation += 1
      this.applying = false
    }
  }

  /**
   * One version's release notes (`plugin/release-notes`), cached per version
   * for ten minutes (a body-less answer for one minute); `force` skips the
   * window AND sends `refresh: true` so the host's own cache is bypassed too —
   * otherwise the card's retry would read the same failure back.
   *
   * An older host has no such endpoint, and a transport failure says nothing
   * about the release: both answer a body-less result carrying the release
   * PAGE, which this module can derive without a network. That is a normal
   * degradation, not an error worth a notice — the link still works.
   *
   * The host's answer is remote data: a body that is not a string is dropped,
   * and only an http(s) page becomes a link, so nothing else can reach the
   * renderer.
   */
  async loadPluginReleaseNotes(version: string, force = false): Promise<PluginReleaseNotes | undefined> {
    if (!force) {
      const cached = this.releaseNotesCache.get(version)
      if (cached !== undefined) {
        const ttl = cached.notes.source === 'none'
          ? PLUGIN_RELEASE_NOTES_FAILURE_TTL_MS
          : PLUGIN_RELEASE_NOTES_TTL_MS
        if (Date.now() - cached.at < ttl) return cached.notes
      }
    }
    const inflight = this.releaseNotesInflight.get(version)
    if (inflight !== undefined) return inflight
    const read = (async (): Promise<PluginReleaseNotes> => {
      const page = pluginReleaseUrl(version)
      let notes: PluginReleaseNotes
      try {
        const value = await this.host.call<PluginReleaseNotes>(
          'plugin/release-notes',
          force ? { version, refresh: true } : { version },
        )
        notes = {
          version,
          url: typeof value.url === 'string' && /^https?:\/\//i.test(value.url) ? value.url : page,
          source: value.source === 'github' || value.source === 'changelog' ? value.source : 'none',
          ...(typeof value.body === 'string' ? { body: value.body } : {}),
          ...(value.truncated === true ? { truncated: true } : {}),
          ...(typeof value.message === 'string' ? { message: value.message } : {}),
        }
      } catch {
        notes = { version, url: page, source: 'none' }
      }
      this.releaseNotesCache.set(version, { at: Date.now(), notes })
      return notes
    })()
    this.releaseNotesInflight.set(version, read)
    try {
      return await read
    } finally {
      this.releaseNotesInflight.delete(version)
    }
  }
}
