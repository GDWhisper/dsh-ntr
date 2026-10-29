/**
 * Host-side built-in update for dsh-ntr.
 *
 * The plugin NEVER downloads a package, swaps files, or restarts itself. The
 * harness plugin manager owns installation (profile bookkeeping, npm, the
 * restart contract); this module only asks it what is installed, asks an npm
 * registry what is published, and delegates the install back to the manager.
 * Every method therefore reports a {@link PluginUpdateState} instead of
 * throwing; version syntax is validated at the RPC boundary (`impl.ts`).
 */

import type { PluginUpdateState } from './protocol.ts'

/** The npm package this plugin is published as, and the bundle name to look for. */
export const UPDATE_PACKAGE = 'dsh-ntr'

/** One npm registry request must answer within this window before the next is tried. */
const REGISTRY_TIMEOUT_MS = 8_000
/** A successful packument answer is reused for this long (per registry base). */
const CACHE_TTL_MS = 10 * 60 * 1000
/** Only stable releases are offered for install. */
const STABLE_VERSION = /^\d+\.\d+\.\d+$/
/** npm's public registry; the only base a private `resolved` may be widened to. */
export const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org'
/** A version spec that resolves through a registry (as opposed to a link/tarball/git). */
const REGISTRY_VERSION_SPEC = /^(?:[\^~]|>=|<=|>|<|=)?\s*v?\d+(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** Dist-tags that name a published release line rather than a local path. */
const REGISTRY_TAGS = new Set(['latest', 'next', 'beta', 'alpha', 'rc', 'stable'])

/**
 * Structural view of one row from the harness plugin manager's
 * `listBundles()`. Deliberately local: importing the host package would tie
 * this module to a runtime version it must merely probe structurally.
 */
export interface UpdateBundleInfo {
  name: string; installed: boolean; removable?: boolean; enabled?: boolean
  version?: string; source?: string; readOnlyReason?: string
  error?: { code?: string; message?: string; diagnostic?: string }
}
/** Structural view of `pluginManager.registries()`. */
export interface UpdateRegistryPlan {
  registry?: string | null; fallbackRegistries?: readonly string[]; resolved?: string | null
}
/** Structural view of the manager's `installBundle()` / `removeBundle()` result (a ChangeResult). */
export interface UpdateInstallResult {
  application?: string; version?: string
  error?: { code?: string; message?: string; diagnostic?: string }
}
/** The plugin-manager face this service needs. Every member is probed, never assumed. */
export interface UpdateManagerLike {
  listBundles?(): Promise<readonly UpdateBundleInfo[]>
  registries?(): Promise<UpdateRegistryPlan>
  installBundle?(spec: string, options?: { enabled?: boolean; registry?: string }): Promise<UpdateInstallResult | undefined>
  /**
   * Native-update half of the harness: `installBundle` refuses to replace an
   * already-installed bundle while HMR holds it, so the host removes first.
   * Optional — older hosts cannot install at all and answer `already-installed`.
   */
  removeBundle?(name: string): Promise<UpdateInstallResult | undefined>
}

/**
 * The shared eligibility verdict. `ok` carries the disk version (when the host
 * reports one); the failure arm is already a full state, so check/apply can
 * return it verbatim.
 */
export type BundleEligibility =
  | { ok: true; installed?: string }
  | { ok: false; state: PluginUpdateState }

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * The host's ChangeResult carries the human-readable cause in `diagnostic`
 * (a `message` field is not always populated). Prefer it, then `message`, and
 * keep the code prefix because the UI shows this verbatim.
 */
function describeFieldError(error: { code?: string; message?: string; diagnostic?: string }): string {
  const text = [error.diagnostic, error.message]
    .find((part): part is string => typeof part === 'string' && part !== '')
  const parts = [error.code, text]
    .filter((part): part is string => typeof part === 'string' && part !== '')
  return parts.length > 0 ? parts.join(': ') : 'the host reported a bundle error'
}

/**
 * Whether a `listBundles().source` value names a registry-resolvable version
 * spec — the only install shape this updater may replace. The test is positive
 * on purpose: link/file/git/workspace/URL/tarball/relative forms all carry a
 * `:` / `/` / `\` or start with `.`, so they fall out without an ever-growing
 * blacklist (a new source scheme must not become silently updatable).
 */
export function isRegistrySpec(source: string): boolean {
  const value = typeof source === 'string' ? source.trim() : ''
  if (value === '') return false
  if (value.startsWith('.')) return false
  if (value.includes(':') || value.includes('/') || value.includes('\\')) return false
  const lowered = value.toLowerCase()
  if (lowered === '*' || lowered === 'x') return true
  if (REGISTRY_TAGS.has(lowered)) return true
  return REGISTRY_VERSION_SPEC.test(value)
}

/**
 * Compare two semver strings (build metadata ignored, prerelease precedence per
 * semver §11). Malformed segments count as `0`, so the function never throws on
 * a value read off a registry.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (raw: string): { core: number[]; pre?: string[] } => {
    let value = raw.trim()
    if (value.startsWith('v') || value.startsWith('V')) value = value.slice(1)
    const plus = value.indexOf('+')
    if (plus >= 0) value = value.slice(0, plus)
    const dash = value.indexOf('-')
    const corePart = dash >= 0 ? value.slice(0, dash) : value
    const prePart = dash >= 0 ? value.slice(dash + 1) : undefined
    const core = corePart.split('.').map(segment => {
      const parsed = Number.parseInt(segment, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
    return { core, pre: prePart === undefined || prePart === '' ? undefined : prePart.split('.') }
  }
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.core.length, right.core.length, 3)
  for (let i = 0; i < length; i += 1) {
    const l = left.core[i] ?? 0
    const r = right.core[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  if (left.pre === undefined && right.pre === undefined) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  const preLength = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < preLength; i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNumeric = /^\d+$/.test(l)
    const rNumeric = /^\d+$/.test(r)
    if (lNumeric && rNumeric) {
      const lNum = Number(l)
      const rNum = Number(r)
      if (lNum !== rNum) return lNum < rNum ? -1 : 1
      continue
    }
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * Turn the manager's registry plan into the ordered list this service will
 * actually query, following the host's privacy rule: a *private* `resolved`
 * registry must not be widened with the shared fallback chain.
 *
 * - No configured registry: query `resolved`; append fallbacks only when it is
 *   npm's public registry or one of the fallbacks themselves.
 * - Configured registry: query it first, then `resolved` under the same
 *   condition, then the fallbacks.
 *
 * http(s) only (a private http registry is legitimate), trailing slashes
 * normalized, duplicates dropped. A base that carries credentials in its URL is
 * skipped: a bare GET cannot replay `.npmrc` auth, so it could only fail with a
 * 401 that reads as "unreachable".
 */
export function registryPlan(plan: UpdateRegistryPlan): string[] {
  const normalize = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(trimmed)) return undefined
    // Credentials in the URL cannot be replayed here: a bare GET would need the
    // `.npmrc` auth the host keeps to itself, so such a base is never queried.
    if (/^https?:\/\/[^/]*@/i.test(trimmed)) return undefined
    return trimmed
  }
  const fallbacks: string[] = []
  for (const fallback of plan.fallbackRegistries ?? []) {
    const normalized = normalize(fallback)
    if (normalized !== undefined && !fallbacks.includes(normalized)) fallbacks.push(normalized)
  }
  const resolved = normalize(plan.resolved)
  const configured = normalize(plan.registry)
  const shared = resolved !== undefined
    && (resolved.toLowerCase() === NPM_PUBLIC_REGISTRY || fallbacks.includes(resolved))
  const out: string[] = []
  const add = (value: string | undefined): void => {
    if (value === undefined || out.includes(value)) return
    out.push(value)
  }
  if (configured !== undefined) {
    add(configured)
    if (shared) add(resolved)
    for (const fallback of fallbacks) add(fallback)
  } else if (resolved !== undefined) {
    add(resolved)
    if (shared) for (const fallback of fallbacks) add(fallback)
  }
  return out
}

/**
 * Pick the version an update should offer.
 *
 * `dist-tags.latest` leads when it is a stable release newer than `current`
 * (that is the line npm itself blesses). Otherwise the highest stable,
 * non-deprecated published version wins — a lagging `latest` tag must not hide
 * a newer release. When nothing is newer, the stable `latest` tag is still
 * returned so the UI can say "you are on the latest release".
 */
export function pickUpdateTarget(packument: unknown, current: string): { version?: string; publishedAt?: string } {
  const row = typeof packument === 'object' && packument !== null ? packument as Record<string, unknown> : {}
  const time = typeof row.time === 'object' && row.time !== null ? row.time as Record<string, unknown> : {}
  const publishedAt = (version: string): string | undefined => {
    const value = time[version]
    return typeof value === 'string' ? value : undefined
  }
  const tags = typeof row['dist-tags'] === 'object' && row['dist-tags'] !== null
    ? row['dist-tags'] as Record<string, unknown>
    : undefined
  const versions = typeof row.versions === 'object' && row.versions !== null
    ? row.versions as Record<string, unknown>
    : undefined
  // A string `deprecated` is npm's tombstone; never offer that release.
  const deprecated = (version: string): boolean => {
    const meta = versions?.[version]
    return typeof meta === 'object' && meta !== null
      && typeof (meta as Record<string, unknown>).deprecated === 'string'
  }
  // `latest` only leads when the registry did not tombstone that very release.
  const latest = typeof tags?.latest === 'string' && STABLE_VERSION.test(tags.latest) && !deprecated(tags.latest)
    ? tags.latest
    : undefined
  if (latest !== undefined && compareVersions(latest, current) > 0) {
    return { version: latest, publishedAt: publishedAt(latest) }
  }
  let best: string | undefined
  for (const [version, meta] of Object.entries(versions ?? {})) {
    if (!STABLE_VERSION.test(version)) continue
    if (typeof meta === 'object' && meta !== null && typeof (meta as Record<string, unknown>).deprecated === 'string') continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  if (best !== undefined && compareVersions(best, current) > 0) {
    return { version: best, publishedAt: publishedAt(best) }
  }
  if (latest !== undefined) return { version: latest, publishedAt: publishedAt(latest) }
  return {}
}

/**
 * Pure eligibility matrix, shared by check and apply.
 *
 * `undefined` means the manager (or one of its methods) is unavailable; an
 * empty list means the manager answered but does not carry this plugin.
 */
export function bundleEligibility(
  bundles: readonly UpdateBundleInfo[] | undefined,
  currentVersion: string,
): BundleEligibility {
  if (bundles === undefined) {
    return {
      ok: false,
      state: {
        status: 'unsupported',
        current: currentVersion,
        message: 'host does not expose the plugin manager',
      },
    }
  }
  const bundle = bundles.find(entry => entry.name === UPDATE_PACKAGE)
  if (bundle === undefined || bundle.installed !== true) {
    return { ok: false, state: { status: 'not-installed', current: currentVersion } }
  }
  const source = typeof bundle.source === 'string' ? bundle.source.trim() : ''
  if (source === '') {
    return {
      ok: false,
      state: {
        status: 'unsupported',
        current: currentVersion,
        message: 'the host does not report where this plugin was installed from',
      },
    }
  }
  if (!isRegistrySpec(source)) {
    // link: / file: / git+ / git@ / github: / workspace: / https tarball /
    // relative path — the disk payload is not what the registry publishes.
    return { ok: false, state: { status: 'source-install', current: currentVersion } }
  }
  if (bundle.removable === false) {
    // The host refuses to unload it, so the remove-then-install path can only fail.
    return {
      ok: false,
      state: {
        status: 'managed',
        current: currentVersion,
        message: 'the host marks this bundle as not removable',
      },
    }
  }
  const readOnlyReason = typeof bundle.readOnlyReason === 'string' ? bundle.readOnlyReason.trim() : ''
  if (readOnlyReason !== '') {
    return {
      ok: false,
      state: { status: 'managed', current: currentVersion, message: readOnlyReason },
    }
  }
  if (bundle.error !== undefined) {
    return {
      ok: false,
      state: { status: 'failed', current: currentVersion, message: describeFieldError(bundle.error) },
    }
  }
  const diskVersion = typeof bundle.version === 'string' && bundle.version.trim() !== ''
    ? bundle.version.trim()
    : undefined
  if (diskVersion !== undefined && compareVersions(diskVersion, currentVersion) !== 0) {
    // Installed on disk but the running host still has the old code loaded.
    // Compare semantically: `v1.1.0` / `1.1.0+build` are the same release.
    return {
      ok: false,
      state: {
        status: 'restart-required',
        current: currentVersion,
        installed: diskVersion,
      },
    }
  }
  return { ok: true, ...(diskVersion === undefined ? {} : { installed: diskVersion }) }
}

/** Unwrap the manager's ChangeResult from the remote `{ok, value}` envelope. */
function unwrapInstallResult(raw: unknown): UpdateInstallResult | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.ok === 'boolean') {
    if (!row.ok) {
      const error = row.error
      const shaped = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
      const message = typeof shaped.message === 'string'
        ? shaped.message
        : typeof error === 'string' ? error : undefined
      return {
        error: {
          ...(typeof shaped.code === 'string' ? { code: shaped.code } : {}),
          ...(typeof shaped.diagnostic === 'string' ? { diagnostic: shaped.diagnostic } : {}),
          ...(message === undefined ? {} : { message }),
        },
      }
    }
    return unwrapInstallResult(row.value)
  }
  return row as unknown as UpdateInstallResult
}

/** Whether a ChangeResult means the requested tree is installed (restart or hot). */
function isInstallSuccess(result: UpdateInstallResult | undefined): result is UpdateInstallResult & { application: 'applied' | 'restart-required' } {
  return result !== undefined && result.error === undefined
    && (result.application === 'applied' || result.application === 'restart-required')
}

/**
 * Whether a `removeBundle` ChangeResult really unloaded the tree. Only "no
 * error and nothing contradicting the removal" counts: a `cancelled` /
 * `overridden` / `failed` application without an `error` still leaves the
 * bundle on disk, so retrying the install would hit `already-installed` again.
 */
function isRemoveSuccess(result: UpdateInstallResult | undefined): boolean {
  if (result === undefined) return true
  if (result.error !== undefined) return false
  return result.application === undefined
    || result.application === 'applied'
    || result.application === 'restart-required'
}

/** A registry URL fit for a message: credentials stripped, no trailing slash. */
function displayRegistry(base: string): string {
  try {
    const url = new URL(base)
    url.username = ''
    url.password = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return base.replace(/\/\/[^/@]*@/, '//')
  }
}

export interface UpdateServiceOptions {
  resolveManager(): UpdateManagerLike | undefined
  currentVersion: string
  isBusy(): boolean
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Update checks and installs, memoized per registry base.
 *
 * Caching exists because the settings page polls: a 10-minute window keeps the
 * check honest without turning every mount into a registry round trip. Apply
 * clears the cache so the next check sees the freshly installed version.
 */
export class UpdateService {
  private readonly resolveManager: () => UpdateManagerLike | undefined
  private readonly currentVersion: string
  private readonly isBusy: () => boolean
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; target: { version?: string; publishedAt?: string } }>()
  private applying = false
  /** Registry that answered the last `available` check, passed through to apply. */
  private lastTarget?: { version: string; registry: string }

  constructor(options: UpdateServiceOptions) {
    this.resolveManager = options.resolveManager
    this.currentVersion = options.currentVersion
    this.isBusy = options.isBusy
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  /** The manager surface plus the disk-version verdict, or a ready-to-return failure state. */
  private async eligibility(): Promise<BundleEligibility> {
    const manager = this.resolveManager()
    if (manager === undefined
      || typeof manager.listBundles !== 'function'
      || typeof manager.registries !== 'function'
      || typeof manager.installBundle !== 'function') {
      return bundleEligibility(undefined, this.currentVersion)
    }
    try {
      return bundleEligibility(await manager.listBundles(), this.currentVersion)
    } catch (error) {
      return { ok: false, state: { status: 'failed', current: this.currentVersion, message: messageOf(error) } }
    }
  }

  private async fetchTarget(base: string): Promise<{ version?: string; publishedAt?: string }> {
    const response = await this.fetchImpl(`${base}/${UPDATE_PACKAGE}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`registry ${base} answered ${String(response.status)}`)
    return pickUpdateTarget(await response.json() as unknown, this.currentVersion)
  }

  /** One registry's packument, via the 10-minute cache. Throws when unreachable. */
  private async targetFor(base: string): Promise<{ version?: string; publishedAt?: string }> {
    const cached = this.cache.get(base)
    if (cached !== undefined && this.now() - cached.at < CACHE_TTL_MS) return cached.target
    const target = await this.fetchTarget(base)
    this.cache.set(base, { at: this.now(), target })
    return target
  }

  /**
   * Ask the manager's registry chain what is published; never installs.
   *
   * A mirror may lag behind the rest of the chain, so a base that only knows
   * the running (or an older) release does not end the walk — the next base
   * gets its turn. `busy` is deliberately not checked here: reading a registry
   * costs no ACP work, and the settings card should still be able to say what
   * is out there while a turn runs.
   */
  async check(): Promise<PluginUpdateState> {
    const current = this.currentVersion
    if (this.applying) return { status: 'applying', current }
    this.lastTarget = undefined
    const eligible = await this.eligibility()
    if (!eligible.ok) return eligible.state
    const installed = eligible.installed === undefined ? {} : { installed: eligible.installed }
    const manager = this.resolveManager()
    let plan: UpdateRegistryPlan
    try {
      plan = (await manager?.registries?.()) ?? {}
    } catch (error) {
      return { status: 'failed', current, message: messageOf(error), ...installed }
    }
    const bases = registryPlan(plan)
    const tried: string[] = []
    let best: { version: string; publishedAt?: string } | undefined
    let reached = 0
    for (const base of bases) {
      tried.push(base)
      let target: { version?: string; publishedAt?: string }
      try {
        target = await this.targetFor(base)
      } catch {
        // Unreachable registry: the next one in the chain gets its turn.
        continue
      }
      reached += 1
      const latest = target.version
      if (latest === undefined) continue
      if (best === undefined || compareVersions(latest, best.version) > 0) {
        best = { version: latest, ...(target.publishedAt === undefined ? {} : { publishedAt: target.publishedAt }) }
      }
      if (compareVersions(latest, current) > 0) {
        if (this.applying) return { status: 'applying', current }
        this.lastTarget = { version: latest, registry: base }
        return {
          status: 'available',
          current,
          latest,
          ...(target.publishedAt === undefined ? {} : { publishedAt: target.publishedAt }),
          registries: tried.map(displayRegistry),
          ...installed,
        }
      }
    }
    // An install may have started while the registry walk was in flight; a late
    // `available` must never reach the client after that.
    if (this.applying) return { status: 'applying', current }
    if (reached === 0) {
      return {
        status: 'failed',
        current,
        message: tried.length === 0
          ? 'no npm registry is configured'
          : `could not reach an npm registry (tried ${tried.map(displayRegistry).join(', ')})`,
        ...(tried.length === 0 ? {} : { registries: tried.map(displayRegistry) }),
        ...installed,
      }
    }
    return {
      status: 'current',
      current,
      ...(best === undefined
        ? {}
        : { latest: best.version, ...(best.publishedAt === undefined ? {} : { publishedAt: best.publishedAt }) }),
      registries: tried.map(displayRegistry),
      ...installed,
    }
  }

  /**
   * Install one exact version through the harness plugin manager.
   *
   * Re-entry while an install is running answers `applying` instead of
   * stacking a second npm operation; the install itself is the host's job.
   *
   * With HMR alive the manager refuses to replace a bundle already in the
   * profile (`already-installed`), so the host's own update semantics are
   * remove-then-install. That is NOT self-replacement: a human gesture started
   * it, the manager still performs every file operation, and it unloads the
   * live module first — exactly what the host does for any bundle update. If
   * the reinstall fails, the previous version is put back through the same
   * `installBundle` path.
   */
  async apply(version: string): Promise<PluginUpdateState> {
    const current = this.currentVersion
    if (compareVersions(version, current) <= 0) {
      // A downgrade (or the running version) is never an update. Version
      // syntax is already enforced at the RPC boundary; answer instead of
      // throwing so a stale UI click cannot surface as an RPC fault.
      return {
        status: 'failed',
        current,
        message: 'the requested version is not newer than the running plugin',
      }
    }
    if (this.applying) return { status: 'applying', current }
    this.applying = true
    try {
      const eligible = await this.eligibility()
      if (!eligible.ok) return eligible.state
      const installed = eligible.installed === undefined ? {} : { installed: eligible.installed }
      if (this.isBusy()) return { status: 'busy', current, ...installed }
      const manager = this.resolveManager()
      const installBundle = manager?.installBundle
      if (manager === undefined || installBundle === undefined) {
        return { status: 'unsupported', current, message: 'host does not expose the plugin manager' }
      }
      const removeBundle = typeof manager.removeBundle === 'function' ? manager.removeBundle : undefined
      const registry = this.lastTarget?.version === version ? this.lastTarget.registry : undefined
      const options: { enabled: boolean; registry?: string } = {
        enabled: true,
        ...(registry === undefined ? {} : { registry }),
      }
      const install = async (target: string, extra: { enabled?: boolean; registry?: string }): Promise<UpdateInstallResult | undefined> =>
        unwrapInstallResult(await installBundle.call(manager, `${UPDATE_PACKAGE}@${target}`, extra))
      const rollback = async (): Promise<boolean> => {
        // The failed install may already have written the target version into
        // the profile, in which case reinstalling the running version answers
        // `already-installed`. Native update semantics: unload first, ignore
        // failures (the target may never have landed), then install through the
        // host's default chain — the target's registry is not ours to reuse.
        if (removeBundle !== undefined) {
          try {
            await removeBundle.call(manager, UPDATE_PACKAGE)
          } catch {
            // Best effort: a bundle that was never installed cannot be removed.
          }
        }
        try {
          return isInstallSuccess(await install(current, { enabled: true }))
        } catch {
          return false
        }
      }
      let result: UpdateInstallResult | undefined
      try {
        result = await install(version, options)
      } catch (error) {
        return { status: 'failed', current, ...installed, message: messageOf(error) }
      }
      if (result?.error?.code === 'already-installed' && removeBundle !== undefined) {
        let removed: UpdateInstallResult | undefined
        try {
          removed = unwrapInstallResult(await removeBundle.call(manager, UPDATE_PACKAGE))
        } catch (error) {
          return {
            status: 'failed',
            current,
            ...installed,
            message: `could not remove the running version: ${messageOf(error)}`,
          }
        }
        if (!isRemoveSuccess(removed)) {
          return {
            status: 'failed',
            current,
            ...installed,
            message: `could not remove the running version: ${removed?.error !== undefined
              ? describeFieldError(removed.error)
              : `the plugin manager answered ${removed?.application ?? 'no result'}`}`,
          }
        }
        let retried: UpdateInstallResult | undefined
        let retryFailure: string | undefined
        try {
          retried = await install(version, options)
        } catch (error) {
          retryFailure = messageOf(error)
        }
        if (retryFailure === undefined && isInstallSuccess(retried)) {
          result = retried
        } else {
          const reason = retryFailure
            ?? (retried?.error === undefined
              ? retried?.application === undefined
                ? 'the plugin manager returned no install result'
                : `the plugin manager answered ${retried.application}`
              : describeFieldError(retried.error))
          const rolledBack = await rollback()
          return {
            status: 'failed',
            current,
            ...(rolledBack ? { installed: current } : {}),
            message: `installing ${version} failed: ${reason}; ${rolledBack ? `rolled back to ${current}` : `rolling back to ${current} also failed`}`,
          }
        }
      }
      if (result !== undefined && result.error !== undefined) {
        // Never report the target as installed here: the disk still holds the
        // previous version.
        return { status: 'failed', current, ...installed, message: describeFieldError(result.error) }
      }
      const application = result?.application
      if (application === 'applied' || application === 'restart-required') {
        this.cache.clear()
        this.lastTarget = undefined
        return { status: application, current, installed: result?.version ?? version }
      }
      if (application === 'overridden') {
        return {
          status: 'failed',
          current,
          ...installed,
          message: 'the installation was overridden by a higher-level configuration',
        }
      }
      if (application === 'cancelled') {
        return { status: 'failed', current, ...installed, message: 'installation was cancelled' }
      }
      return {
        status: 'failed',
        current,
        ...installed,
        message: application === undefined
          ? 'the plugin manager returned no install result'
          : `the plugin manager returned an unexpected application state: ${application}`,
      }
    } finally {
      this.applying = false
    }
  }
}
