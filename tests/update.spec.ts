import { describe, expect, it } from 'vitest'
import {
  UPDATE_PACKAGE,
  UpdateService,
  bundleEligibility,
  compareVersions,
  isRegistrySpec,
  pickUpdateTarget,
  registryPlan,
} from '../src/update.ts'
import type {
  UpdateBundleInfo,
  UpdateInstallResult,
  UpdateManagerLike,
  UpdateRegistryPlan,
} from '../src/update.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function fetchFrom(
  handler: (url: string) => Response | Promise<Response>,
  calls: string[],
  inits: RequestInit[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (init !== undefined) inits.push(init)
    return handler(url)
  }) as typeof fetch
}

function bundle(overrides: Partial<UpdateBundleInfo> = {}): UpdateBundleInfo {
  return { name: UPDATE_PACKAGE, installed: true, source: '^1.0.0', version: '1.0.0', ...overrides }
}

function managerWith(overrides: Partial<UpdateManagerLike> = {}): UpdateManagerLike {
  return {
    listBundles: async () => [bundle()],
    registries: async () => ({ registry: 'https://registry.example/' }),
    installBundle: async () => ({ application: 'applied', version: '1.1.0' }),
    ...overrides,
  }
}

function service(options: {
  manager?: UpdateManagerLike
  current?: string
  busy?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
} = {}): UpdateService {
  return new UpdateService({
    resolveManager: () => options.manager,
    currentVersion: options.current ?? '1.0.0',
    isBusy: () => options.busy === true,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

const packument = (versions: string[], latest?: string, time?: Record<string, string>): unknown => ({
  versions: Object.fromEntries(versions.map(version => [version, {}])),
  'dist-tags': { latest: latest ?? versions[versions.length - 1] },
  ...(time === undefined ? {} : { time }),
})

describe('compareVersions', () => {
  it('orders release cores numerically', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
  })

  it('applies prerelease precedence', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.2')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-rc.1+sha', '1.0.0-rc.1')).toBe(0)
  })
})

describe('isRegistrySpec', () => {
  it('accepts registry version specs', () => {
    for (const source of [
      '1.0.0', 'v1.0.0', '^1.0.0', '~1.0.0', '>=1.0.0', '<=1.0.0', '>1.0.0', '<1.0.0', '=1.0.0',
      '*', 'x', 'latest', 'next', 'beta', 'alpha', 'rc', 'stable',
    ]) {
      expect(isRegistrySpec(source), source).toBe(true)
    }
  })

  it('rejects every non-registry source form', () => {
    for (const source of [
      '', '   ', 'link:../dsh-ntr', 'file:/opt/dsh-ntr', 'git+https://github.com/x/y.git',
      'git@github.com:x/y.git', 'github:x/y', 'workspace:*',
      'https://github.com/x/y/tarball/main',
      'https://registry.npmjs.org/dsh-ntr/-/dsh-ntr-1.0.0.tgz',
      './dsh-ntr', '../dsh-ntr', '.', '/opt/dsh-ntr', 'C:\\work\\dsh-ntr', 'npm',
    ]) {
      expect(isRegistrySpec(source), source).toBe(false)
    }
  })
})

describe('registryPlan', () => {
  it('keeps a private resolved registry out of the fallback chain', () => {
    expect(registryPlan({
      registry: 'https://a.example/',
      resolved: 'https://b.example',
      fallbackRegistries: ['https://c.example//', 'https://a.example'],
    })).toEqual(['https://a.example', 'https://c.example'])
  })

  it('follows resolved into the shared chain when it is public or a fallback itself', () => {
    expect(registryPlan({
      registry: 'https://a.example/',
      resolved: 'https://registry.npmjs.org/',
      fallbackRegistries: ['https://c.example'],
    })).toEqual(['https://a.example', 'https://registry.npmjs.org', 'https://c.example'])
    expect(registryPlan({
      registry: 'https://a.example/',
      resolved: 'https://b.example',
      fallbackRegistries: ['https://b.example/', 'https://c.example'],
    })).toEqual(['https://a.example', 'https://b.example', 'https://c.example'])
  })

  it('uses only resolved when no registry is configured, widening only shared bases', () => {
    expect(registryPlan({
      registry: null,
      resolved: 'https://registry.npmjs.org',
      fallbackRegistries: ['https://c.example'],
    })).toEqual(['https://registry.npmjs.org', 'https://c.example'])
    expect(registryPlan({
      registry: null,
      resolved: 'https://b.example',
      fallbackRegistries: ['https://b.example', 'https://c.example'],
    })).toEqual(['https://b.example', 'https://c.example'])
    expect(registryPlan({
      registry: null,
      resolved: 'https://private.example',
      fallbackRegistries: ['https://c.example'],
    })).toEqual(['https://private.example'])
  })

  it('skips empty and non-http(s) entries but keeps a private http registry', () => {
    expect(registryPlan({
      registry: 'ftp://a.example',
      resolved: 'https://registry.npmjs.org',
      fallbackRegistries: ['file:///tmp/reg', 'not a url', '', 'http://insecure.example/'],
    })).toEqual(['https://registry.npmjs.org', 'http://insecure.example'])
  })

  it('answers an empty plan when nothing is configured', () => {
    expect(registryPlan({})).toEqual([])
    expect(registryPlan({ registry: null, resolved: null, fallbackRegistries: [] })).toEqual([])
  })

  it('skips registry URLs that carry credentials', () => {
    expect(registryPlan({
      registry: 'https://user:secret@a.example/',
      resolved: 'https://registry.npmjs.org',
      fallbackRegistries: ['https://b.example'],
    })).toEqual(['https://registry.npmjs.org', 'https://b.example'])
    expect(registryPlan({ registry: 'https://token@a.example/' })).toEqual([])
    expect(registryPlan({ resolved: 'https://user:secret@a.example/' })).toEqual([])
  })
})

describe('pickUpdateTarget', () => {
  it('picks the highest stable version newer than current, with its publish time', () => {
    expect(pickUpdateTarget({
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {}, '1.3.0-beta.1': {} },
      'dist-tags': { latest: '1.3.0-beta.1' },
      time: { '1.2.0': '2026-10-01T00:00:00.000Z' },
    }, '1.0.0')).toEqual({ version: '1.2.0', publishedAt: '2026-10-01T00:00:00.000Z' })
  })

  it('prefers a stable dist-tags.latest over a higher published version', () => {
    expect(pickUpdateTarget({
      versions: { '1.1.0': {}, '1.2.0': {} },
      'dist-tags': { latest: '1.1.0' },
      time: { '1.1.0': '2026-10-02T00:00:00.000Z' },
    }, '1.0.0')).toEqual({ version: '1.1.0', publishedAt: '2026-10-02T00:00:00.000Z' })
  })

  it('skips deprecated versions', () => {
    expect(pickUpdateTarget({
      versions: { '1.1.0': { deprecated: 'broken build' }, '1.2.0': {} },
      'dist-tags': { latest: '1.0.0' },
    }, '1.0.0')).toEqual({ version: '1.2.0', publishedAt: undefined })
  })

  it('does not follow a latest tag that points at a deprecated release', () => {
    expect(pickUpdateTarget({
      versions: { '1.1.0': { deprecated: 'broken build' }, '1.2.0': {} },
      'dist-tags': { latest: '1.1.0' },
    }, '1.0.0')).toEqual({ version: '1.2.0', publishedAt: undefined })
    expect(pickUpdateTarget({
      versions: { '1.1.0': { deprecated: 'yanked' } },
      'dist-tags': { latest: '1.1.0' },
    }, '1.0.0')).toEqual({})
  })

  it('never offers a prerelease from versions', () => {
    expect(pickUpdateTarget({
      versions: { '1.0.0': {}, '1.1.0-rc.1': {} },
      'dist-tags': { latest: '1.1.0-rc.1' },
    }, '0.9.0')).toEqual({ version: '1.0.0', publishedAt: undefined })
  })

  it('falls back to the stable latest tag when nothing is newer', () => {
    expect(pickUpdateTarget({
      versions: { '1.0.0': {}, '1.2.0': {} },
      'dist-tags': { latest: '1.2.0' },
      time: { '1.2.0': '2026-09-01T00:00:00.000Z' },
    }, '2.0.0')).toEqual({ version: '1.2.0', publishedAt: '2026-09-01T00:00:00.000Z' })
  })

  it('returns nothing when no stable version exists', () => {
    expect(pickUpdateTarget({
      versions: { '2.0.0-beta.1': {} },
      'dist-tags': { latest: '2.0.0-beta.1' },
    }, '1.0.0')).toEqual({})
    expect(pickUpdateTarget({ versions: {}, 'dist-tags': { latest: 'next' } }, '1.0.0')).toEqual({})
    expect(pickUpdateTarget(null, '1.0.0')).toEqual({})
  })

  it('accepts a stable latest tag even when versions is missing', () => {
    expect(pickUpdateTarget({ 'dist-tags': { latest: '1.4.0' } }, '1.0.0'))
      .toEqual({ version: '1.4.0', publishedAt: undefined })
  })
})

describe('bundleEligibility', () => {
  it('reports unsupported when the manager is unavailable', () => {
    expect(bundleEligibility(undefined, '1.0.0')).toEqual({
      ok: false,
      state: { status: 'unsupported', current: '1.0.0', message: 'host does not expose the plugin manager' },
    })
  })

  it('reports not-installed for a missing or non-installed bundle', () => {
    expect(bundleEligibility([], '1.0.0')).toEqual({ ok: false, state: { status: 'not-installed', current: '1.0.0' } })
    expect(bundleEligibility([bundle({ name: 'other' })], '1.0.0'))
      .toEqual({ ok: false, state: { status: 'not-installed', current: '1.0.0' } })
    expect(bundleEligibility([bundle({ installed: false })], '1.0.0'))
      .toEqual({ ok: false, state: { status: 'not-installed', current: '1.0.0' } })
  })

  it('reports unsupported on hosts that do not report an install source', () => {
    for (const source of [undefined, '', '   ']) {
      expect(bundleEligibility([bundle({ source })], '1.0.0')).toEqual({
        ok: false,
        state: {
          status: 'unsupported',
          current: '1.0.0',
          message: 'the host does not report where this plugin was installed from',
        },
      })
    }
  })

  it('accepts registry version specs as updatable installs', () => {
    for (const source of ['1.0.0', '^1.0.0', 'latest', '*', 'x']) {
      expect(bundleEligibility([bundle({ source })], '1.0.0')).toEqual({ ok: true, installed: '1.0.0' })
    }
  })

  it('refuses source installs, tarball URLs and relative paths', () => {
    for (const source of [
      'link:../dsh-ntr', 'file:/opt/dsh-ntr', 'git+https://github.com/x/y.git', 'git@github.com:x/y.git',
      'github:x/y', 'https://github.com/x/y', 'https://github.com/x/y/tarball/main', 'workspace:*',
      './dsh-ntr', '../dsh-ntr', '/opt/dsh-ntr',
    ]) {
      expect(bundleEligibility([bundle({ source })], '1.0.0'))
        .toEqual({ ok: false, state: { status: 'source-install', current: '1.0.0' } })
    }
  })

  it('reports managed bundles with the host’s reason', () => {
    expect(bundleEligibility([bundle({ readOnlyReason: 'bundled with the host profile' })], '1.0.0')).toEqual({
      ok: false,
      state: { status: 'managed', current: '1.0.0', message: 'bundled with the host profile' },
    })
  })

  it('reports a non-removable bundle as managed', () => {
    expect(bundleEligibility([bundle({ removable: false })], '1.0.0')).toEqual({
      ok: false,
      state: { status: 'managed', current: '1.0.0', message: 'the host marks this bundle as not removable' },
    })
    expect(bundleEligibility([bundle({ removable: true })], '1.0.0')).toEqual({ ok: true, installed: '1.0.0' })
  })

  it('reports a bundle error with its code and message', () => {
    expect(bundleEligibility([bundle({ error: { code: 'EACCES', message: 'denied' } })], '1.0.0')).toEqual({
      ok: false,
      state: { status: 'failed', current: '1.0.0', message: 'EACCES: denied' },
    })
    expect(bundleEligibility([bundle({ error: { code: 'EACCES' } })], '1.0.0')).toEqual({
      ok: false,
      state: { status: 'failed', current: '1.0.0', message: 'EACCES' },
    })
  })

  it('prefers a bundle error diagnostic over its message', () => {
    expect(bundleEligibility([bundle({
      error: { code: 'EACCES', message: 'boom', diagnostic: 'profile is read-only' },
    })], '1.0.0')).toEqual({
      ok: false,
      state: { status: 'failed', current: '1.0.0', message: 'EACCES: profile is read-only' },
    })
  })

  it('reports restart-required when disk differs from the running version', () => {
    expect(bundleEligibility([bundle({ version: '1.1.0' })], '1.0.0')).toEqual({
      ok: false,
      state: { status: 'restart-required', current: '1.0.0', installed: '1.1.0' },
    })
    expect(bundleEligibility([bundle({ version: '0.9.0' })], '1.0.0')).toEqual({
      ok: false,
      state: { status: 'restart-required', current: '1.0.0', installed: '0.9.0' },
    })
  })

  it('compares disk versions semantically, not as strings', () => {
    expect(bundleEligibility([bundle({ version: 'v1.0.0' })], '1.0.0'))
      .toEqual({ ok: true, installed: 'v1.0.0' })
    expect(bundleEligibility([bundle({ version: '1.0.0+build.7' })], '1.0.0'))
      .toEqual({ ok: true, installed: '1.0.0+build.7' })
  })

  it('is ok when the disk version matches the running one', () => {
    expect(bundleEligibility([bundle({ version: '1.0.0' })], '1.0.0')).toEqual({ ok: true, installed: '1.0.0' })
    expect(bundleEligibility([bundle({ version: undefined })], '1.0.0')).toEqual({ ok: true })
  })
})

describe('UpdateService.check', () => {
  it('reports an available update with the registries actually asked', async () => {
    const calls: string[] = []
    const inits: RequestInit[] = []
    const fetchImpl = fetchFrom(() => jsonResponse({
      versions: { '1.0.0': {}, '1.1.0': {} },
      'dist-tags': { latest: '1.1.0' },
      time: { '1.1.0': '2026-09-30T12:00:00.000Z' },
    }), calls, inits)
    const result = await service({ manager: managerWith(), fetchImpl }).check()
    expect(result).toEqual({
      status: 'available',
      current: '1.0.0',
      installed: '1.0.0',
      latest: '1.1.0',
      publishedAt: '2026-09-30T12:00:00.000Z',
      registries: ['https://registry.example'],
    })
    expect(calls).toEqual(['https://registry.example/dsh-ntr'])
    expect(inits[0]?.headers).toEqual({ accept: 'application/json' })
  })

  it('reports current when the registry has nothing newer', async () => {
    const fetchImpl = fetchFrom(() => jsonResponse(packument(['1.0.0'], '1.0.0', {
      '1.0.0': '2026-08-01T00:00:00.000Z',
    })), [])
    const result = await service({ manager: managerWith(), fetchImpl }).check()
    expect(result).toEqual({
      status: 'current',
      current: '1.0.0',
      installed: '1.0.0',
      latest: '1.0.0',
      publishedAt: '2026-08-01T00:00:00.000Z',
      registries: ['https://registry.example'],
    })
  })

  it('stops before any request for ineligible installs', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(() => jsonResponse({}), calls)
    const source = await service({
      manager: managerWith({ listBundles: async () => [bundle({ source: 'link:../dsh-ntr' })] }),
      fetchImpl,
    }).check()
    expect(source).toEqual({ status: 'source-install', current: '1.0.0' })
    const missing = await service({ manager: undefined, fetchImpl }).check()
    expect(missing).toEqual({
      status: 'unsupported',
      current: '1.0.0',
      message: 'host does not expose the plugin manager',
    })
    const notInstalled = await service({ manager: managerWith({ listBundles: async () => [] }), fetchImpl }).check()
    expect(notInstalled).toEqual({ status: 'not-installed', current: '1.0.0' })
    expect(calls).toEqual([])
  })

  it('answers unsupported when the manager lacks a required method', async () => {
    const bare = { listBundles: async () => [bundle()] } as UpdateManagerLike
    expect(await service({ manager: bare }).check()).toEqual({
      status: 'unsupported',
      current: '1.0.0',
      message: 'host does not expose the plugin manager',
    })
    const noRegistries = {
      listBundles: async () => [bundle()],
      installBundle: async () => ({ application: 'applied' }),
    } as UpdateManagerLike
    expect(await service({ manager: noRegistries }).check()).toEqual({
      status: 'unsupported',
      current: '1.0.0',
      message: 'host does not expose the plugin manager',
    })
  })

  it('reports a disk/running mismatch as restart-required without a registry request', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(() => jsonResponse({}), calls)
    const manager = managerWith({ listBundles: async () => [bundle({ version: '1.1.0' })] })
    expect(await service({ manager, fetchImpl }).check()).toEqual({
      status: 'restart-required',
      current: '1.0.0',
      installed: '1.1.0',
    })
    expect(calls).toEqual([])
  })

  it('reports restart-required without calling an older disk version the latest', async () => {
    const manager = managerWith({ listBundles: async () => [bundle({ version: '0.9.0' })] })
    const state = await service({ manager }).check()
    expect(state).toEqual({ status: 'restart-required', current: '1.0.0', installed: '0.9.0' })
    expect(state.latest).toBeUndefined()
  })

  it('answers failed when listing bundles throws', async () => {
    const manager = managerWith({ listBundles: async () => { throw new Error('profile unreadable') } })
    expect(await service({ manager }).check()).toEqual({
      status: 'failed',
      current: '1.0.0',
      message: 'profile unreadable',
    })
  })

  it('does not treat an in-flight ACP turn as busy', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(() => jsonResponse(packument(['1.1.0'], '1.1.0')), calls)
    expect(await service({ manager: managerWith(), fetchImpl, busy: true }).check()).toMatchObject({
      status: 'available',
      latest: '1.1.0',
    })
    expect(calls).toHaveLength(1)
  })

  it('answers applying instead of reading the registry during an install', async () => {
    let release!: (value: UpdateInstallResult) => void
    const gate = new Promise<UpdateInstallResult>(resolve => { release = resolve })
    const calls: string[] = []
    const manager = managerWith({ installBundle: () => gate })
    const svc = service({ manager, fetchImpl: fetchFrom(() => jsonResponse({}), calls) })
    const first = svc.apply('1.1.0')
    expect(await svc.check()).toEqual({ status: 'applying', current: '1.0.0' })
    expect(calls).toEqual([])
    release({ application: 'applied', version: '1.1.0' })
    expect((await first).status).toBe('applied')
  })

  it('answers applying when an install starts while the registry read is in flight', async () => {
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve })
    let releaseInstall!: (value: UpdateInstallResult) => void
    const installGate = new Promise<UpdateInstallResult>(resolve => { releaseInstall = resolve })
    const manager = managerWith({ installBundle: async () => installGate })
    const fetchImpl = fetchFrom(async () => {
      await fetchGate
      return jsonResponse(packument(['1.1.0'], '1.1.0'))
    }, [])
    const svc = service({ manager, fetchImpl })
    const pendingCheck = svc.check()
    const pendingApply = svc.apply('1.1.0')
    releaseFetch()
    expect(await pendingCheck).toEqual({ status: 'applying', current: '1.0.0' })
    releaseInstall({ application: 'applied', version: '1.1.0' })
    expect((await pendingApply).status).toBe('applied')
  })

  it('walks the registry chain and reports every attempted base on total failure', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(() => jsonResponse({}, 503), calls)
    const manager = managerWith({
      registries: async (): Promise<UpdateRegistryPlan> => ({
        registry: 'https://a.example/',
        fallbackRegistries: ['https://b.example'],
      }),
    })
    const result = await service({ manager, fetchImpl }).check()
    expect(result).toMatchObject({
      status: 'failed',
      current: '1.0.0',
      registries: ['https://a.example', 'https://b.example'],
    })
    expect(result.message).toContain('https://a.example')
    expect(result.message).toContain('https://b.example')
    expect(calls).toEqual(['https://a.example/dsh-ntr', 'https://b.example/dsh-ntr'])
  })

  it('strips credentials from registries named in the failure message', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(() => jsonResponse({}, 503), calls)
    const manager = managerWith({
      registries: async () => ({ registry: 'https://user:secret@a.example/' }),
    })
    const result = await service({ manager, fetchImpl }).check()
    expect(result.status).toBe('failed')
    expect(result.message).toBe('no npm registry is configured')
    expect(result.message).not.toContain('secret')
    expect(calls).toEqual([])
  })

  it('reports both states with credential-free registry URLs', async () => {
    const manager = managerWith({ registries: async () => ({ registry: 'https://a.example:443/' }) })
    const available = await service({
      manager,
      fetchImpl: fetchFrom(() => jsonResponse(packument(['1.1.0'], '1.1.0')), []),
    }).check()
    expect(available).toMatchObject({ status: 'available', registries: ['https://a.example'] })
    const current = await service({
      manager,
      fetchImpl: fetchFrom(() => jsonResponse(packument(['1.0.0'], '1.0.0')), []),
    }).check()
    expect(current).toMatchObject({ status: 'current', registries: ['https://a.example'] })
  })

  it('falls through a thrown registry to the next one', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(url => {
      if (url.startsWith('https://a.example')) throw new Error('offline')
      return jsonResponse(packument(['1.2.0'], '1.2.0'))
    }, calls)
    const manager = managerWith({
      registries: async () => ({ registry: 'https://a.example/', fallbackRegistries: ['https://b.example'] }),
    })
    expect(await service({ manager, fetchImpl }).check()).toMatchObject({
      status: 'available',
      latest: '1.2.0',
      registries: ['https://a.example', 'https://b.example'],
    })
    expect(calls).toHaveLength(2)
  })

  it('keeps asking after a mirror that only knows the running version', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(url => url.startsWith('https://a.example')
      ? jsonResponse(packument(['1.0.0'], '1.0.0'))
      : jsonResponse(packument(['1.1.0'], '1.1.0')), calls)
    const manager = managerWith({
      registries: async () => ({ registry: 'https://a.example/', fallbackRegistries: ['https://b.example'] }),
    })
    expect(await service({ manager, fetchImpl }).check()).toMatchObject({
      status: 'available',
      latest: '1.1.0',
      registries: ['https://a.example', 'https://b.example'],
    })
    expect(calls).toEqual(['https://a.example/dsh-ntr', 'https://b.example/dsh-ntr'])
  })

  it('reports the highest target across the chain when nothing is newer', async () => {
    const fetchImpl = fetchFrom(url => url.startsWith('https://a.example')
      ? jsonResponse(packument(['2.0.0'], '2.0.0'))
      : jsonResponse(packument(['2.1.0'], '2.1.0')), [])
    const manager = managerWith({
      registries: async () => ({ registry: 'https://a.example/', fallbackRegistries: ['https://b.example'] }),
      listBundles: async () => [bundle({ version: '3.0.0' })],
    })
    expect(await service({ manager, current: '3.0.0', fetchImpl }).check()).toEqual({
      status: 'current',
      current: '3.0.0',
      installed: '3.0.0',
      latest: '2.1.0',
      registries: ['https://a.example', 'https://b.example'],
    })
  })

  it('facts a failed registry read as a failed check', async () => {
    const manager = managerWith({ registries: async () => { throw new Error('no registry plan') } })
    expect(await service({ manager }).check()).toEqual({
      status: 'failed',
      current: '1.0.0',
      installed: '1.0.0',
      message: 'no registry plan',
    })
  })

  it('fails honestly when no registry is configured', async () => {
    const result = await service({ manager: managerWith({ registries: async () => ({}) }) }).check()
    expect(result).toMatchObject({ status: 'failed', message: 'no npm registry is configured' })
  })
})

describe('UpdateService cache', () => {
  it('reuses one packument for 10 minutes, then fetches again', async () => {
    let now = 1_000_000
    const calls: string[] = []
    const fetchImpl = fetchFrom(() => jsonResponse(packument(['1.1.0'], '1.1.0')), calls)
    const svc = service({ manager: managerWith(), fetchImpl, now: () => now })
    expect((await svc.check()).status).toBe('available')
    expect((await svc.check()).status).toBe('available')
    expect(calls).toHaveLength(1)
    now += 11 * 60 * 1000
    expect((await svc.check()).status).toBe('available')
    expect(calls).toHaveLength(2)
  })

  it('drops the cache after an apply', async () => {
    const calls: string[] = []
    const fetchImpl = fetchFrom(() => jsonResponse(packument(['1.1.0'], '1.1.0')), calls)
    const svc = service({ manager: managerWith(), fetchImpl })
    await svc.check()
    await svc.apply('1.1.0')
    await svc.check()
    expect(calls).toHaveLength(2)
  })
})

describe('UpdateService.apply', () => {
  it('installs exactly one version through the manager and reports applied', async () => {
    const installs: Array<{ spec: string; options?: { enabled?: boolean; registry?: string } }> = []
    const manager = managerWith({
      installBundle: async (spec, options) => {
        installs.push({ spec, options })
        return { application: 'applied', version: '1.1.0' }
      },
    })
    expect(await service({ manager }).apply('1.1.0')).toEqual({
      status: 'applied',
      current: '1.0.0',
      installed: '1.1.0',
    })
    expect(installs).toEqual([{ spec: 'dsh-ntr@1.1.0', options: { enabled: true } }])
  })

  it('passes the registry that answered the check through to the install', async () => {
    const calls: string[] = []
    const installs: Array<{ spec: string; options?: { enabled?: boolean; registry?: string } }> = []
    const fetchImpl = fetchFrom(url => url.startsWith('https://a.example')
      ? jsonResponse(packument(['1.0.0'], '1.0.0'))
      : jsonResponse(packument(['1.1.0'], '1.1.0')), calls)
    const manager = managerWith({
      registries: async () => ({ registry: 'https://a.example/', fallbackRegistries: ['https://b.example'] }),
      installBundle: async (spec, options) => {
        installs.push({ spec, options })
        return { application: 'applied', version: '1.1.0' }
      },
    })
    const svc = service({ manager, fetchImpl })
    expect((await svc.check()).status).toBe('available')
    expect(await svc.apply('1.1.0')).toMatchObject({ status: 'applied', installed: '1.1.0' })
    expect(installs).toEqual([
      { spec: 'dsh-ntr@1.1.0', options: { enabled: true, registry: 'https://b.example' } },
    ])
  })

  it('unwraps the remote {ok, value} envelope', async () => {
    const manager = managerWith({
      installBundle: async () => ({ ok: true, value: { application: 'applied', version: '1.2.0' } } as unknown as UpdateInstallResult),
    })
    expect(await service({ manager }).apply('1.2.0')).toMatchObject({ status: 'applied', installed: '1.2.0' })
    const refused = managerWith({
      installBundle: async () => ({
        ok: false,
        error: { code: 'EACCES', diagnostic: 'profile write denied' },
      } as unknown as UpdateInstallResult),
    })
    expect(await service({ manager: refused }).apply('1.2.0')).toMatchObject({
      status: 'failed',
      message: 'EACCES: profile write denied',
    })
  })

  it('maps restart-required', async () => {
    const manager = managerWith({
      installBundle: async () => ({ application: 'restart-required', version: '1.1.0' }),
    })
    expect(await service({ manager }).apply('1.1.0')).toEqual({
      status: 'restart-required',
      current: '1.0.0',
      installed: '1.1.0',
    })
  })

  it('prefers error.diagnostic over message', async () => {
    const manager = managerWith({
      installBundle: async () => ({
        error: { code: 'EACCES', message: 'boom', diagnostic: 'permission denied writing the profile' },
      }),
    })
    expect(await service({ manager }).apply('1.1.0')).toMatchObject({
      status: 'failed',
      message: 'EACCES: permission denied writing the profile',
    })
  })

  it('maps install errors, thrown failures and missing results to failed', async () => {
    const errored = managerWith({
      installBundle: async () => ({ error: { code: 'EAI_AGAIN', message: 'registry unreachable' } }),
    })
    expect(await service({ manager: errored }).apply('1.1.0')).toEqual({
      status: 'failed',
      current: '1.0.0',
      installed: '1.0.0',
      message: 'EAI_AGAIN: registry unreachable',
    })
    const thrown = managerWith({ installBundle: async () => { throw new Error('npm exploded') } })
    expect(await service({ manager: thrown }).apply('1.1.0')).toMatchObject({
      status: 'failed',
      message: 'npm exploded',
    })
    const empty = managerWith({ installBundle: async () => undefined })
    expect(await service({ manager: empty }).apply('1.1.0')).toMatchObject({
      status: 'failed',
      message: 'the plugin manager returned no install result',
    })
    const unexpected = managerWith({
      installBundle: async () => ({ application: 'queued', version: '1.1.0' }),
    })
    const state = await service({ manager: unexpected }).apply('1.1.0')
    expect(state).toMatchObject({ status: 'failed', installed: '1.0.0' })
    expect(state.message).toContain('queued')
  })

  it('never reports the target version as installed on failure', async () => {
    const manager = managerWith({
      installBundle: async () => ({ application: 'failed', version: '1.1.0', error: { code: 'EACCES' } }),
    })
    const state = await service({ manager }).apply('1.1.0')
    expect(state).toMatchObject({ status: 'failed', installed: '1.0.0' })
    expect(state.installed).not.toBe('1.1.0')
  })

  it('maps overridden and cancelled installs to failed', async () => {
    const overridden = managerWith({
      installBundle: async () => ({ application: 'overridden', version: '1.1.0' }),
    })
    const overriddenState = await service({ manager: overridden }).apply('1.1.0')
    expect(overriddenState).toMatchObject({ status: 'failed', installed: '1.0.0' })
    expect(overriddenState.message).toContain('overridden')
    const cancelled = managerWith({ installBundle: async () => ({ application: 'cancelled' }) })
    expect(await service({ manager: cancelled }).apply('1.1.0')).toMatchObject({
      status: 'failed',
      message: 'installation was cancelled',
    })
  })

  it('rejects a concurrent apply while one is running', async () => {
    let release!: (value: UpdateInstallResult) => void
    const gate = new Promise<UpdateInstallResult>(resolve => { release = resolve })
    const manager = managerWith({ installBundle: () => gate })
    const svc = service({ manager })
    const first = svc.apply('1.1.0')
    expect(await svc.apply('1.1.0')).toEqual({ status: 'applying', current: '1.0.0' })
    release({ application: 'applied', version: '1.1.0' })
    expect((await first).status).toBe('applied')
  })

  it('answers busy without installing', async () => {
    let installs = 0
    const manager = managerWith({ installBundle: async () => { installs += 1; return undefined } })
    expect(await service({ manager, busy: true }).apply('1.1.0')).toEqual({
      status: 'busy',
      current: '1.0.0',
      installed: '1.0.0',
    })
    expect(installs).toBe(0)
  })

  it('answers unsupported when no manager is wired', async () => {
    expect(await service({ manager: undefined }).apply('1.1.0')).toEqual({
      status: 'unsupported',
      current: '1.0.0',
      message: 'host does not expose the plugin manager',
    })
    const noInstall = {
      listBundles: async () => [bundle()],
      registries: async () => ({ registry: 'https://registry.example' }),
    } as UpdateManagerLike
    expect(await service({ manager: noInstall }).apply('1.1.0')).toEqual({
      status: 'unsupported',
      current: '1.0.0',
      message: 'host does not expose the plugin manager',
    })
  })

  it('refuses versions that are not newer than the running plugin', async () => {
    let installs = 0
    const manager = managerWith({ installBundle: async () => { installs += 1; return undefined } })
    const svc = service({ manager })
    for (const version of ['1.0.0', '0.9.9']) {
      expect(await svc.apply(version)).toEqual({
        status: 'failed',
        current: '1.0.0',
        message: 'the requested version is not newer than the running plugin',
      })
    }
    expect(installs).toBe(0)
  })

  it('reuses shared eligibility: a disk/running mismatch refuses the install', async () => {
    let installs = 0
    const manager = managerWith({
      listBundles: async () => [bundle({ version: '1.1.0' })],
      installBundle: async () => { installs += 1; return undefined },
    })
    expect(await service({ manager }).apply('1.2.0')).toEqual({
      status: 'restart-required',
      current: '1.0.0',
      installed: '1.1.0',
    })
    expect(installs).toBe(0)
  })

  it('removes an already-installed bundle before retrying (HMR host)', async () => {
    const calls: string[] = []
    let installs = 0
    const manager = managerWith({
      installBundle: async spec => {
        calls.push(`install:${spec}`)
        installs += 1
        return installs === 1
          ? { application: 'failed', error: { code: 'already-installed', diagnostic: 'bundle is loaded by HMR' } }
          : { application: 'restart-required', version: '1.1.0' }
      },
      removeBundle: async name => {
        calls.push(`remove:${name}`)
        return { application: 'applied' }
      },
    })
    expect(await service({ manager }).apply('1.1.0')).toEqual({
      status: 'restart-required',
      current: '1.0.0',
      installed: '1.1.0',
    })
    expect(calls).toEqual([
      'install:dsh-ntr@1.1.0',
      'remove:dsh-ntr',
      'install:dsh-ntr@1.1.0',
    ])
  })

  it('fails with the remove diagnostic and never retries when removal fails', async () => {
    const calls: string[] = []
    const manager = managerWith({
      installBundle: async spec => {
        calls.push(spec)
        return { application: 'failed', error: { code: 'already-installed' } }
      },
      removeBundle: async () => ({ application: 'failed', error: { code: 'EACCES', diagnostic: 'profile is locked' } }),
    })
    const state = await service({ manager }).apply('1.1.0')
    expect(state).toMatchObject({ status: 'failed', installed: '1.0.0' })
    expect(state.message).toContain('could not remove the running version: EACCES: profile is locked')
    expect(calls).toEqual(['dsh-ntr@1.1.0'])
  })

  it('treats a non-applied remove result without an error as a removal failure', async () => {
    for (const application of ['cancelled', 'overridden', 'failed']) {
      let installs = 0
      const manager = managerWith({
        installBundle: async () => {
          installs += 1
          return { application: 'failed', error: { code: 'already-installed' } }
        },
        removeBundle: async () => ({ application }),
      })
      const state = await service({ manager }).apply('1.1.0')
      expect(state).toMatchObject({ status: 'failed', installed: '1.0.0' })
      expect(state.message).toContain('could not remove the running version')
      expect(state.message).toContain(application)
      expect(installs).toBe(1)
    }
  })

  it('rolls back to the running version when the retried install fails', async () => {
    const specs: string[] = []
    let installs = 0
    const manager = managerWith({
      installBundle: async spec => {
        specs.push(spec)
        installs += 1
        if (installs === 1) return { application: 'failed', error: { code: 'already-installed' } }
        if (installs === 2) return { application: 'failed', error: { code: 'EAI_AGAIN', diagnostic: 'registry unreachable' } }
        return { application: 'restart-required', version: '1.0.0' }
      },
      removeBundle: async () => ({ application: 'applied' }),
    })
    expect(await service({ manager }).apply('1.1.0')).toEqual({
      status: 'failed',
      current: '1.0.0',
      installed: '1.0.0',
      message: 'installing 1.1.0 failed: EAI_AGAIN: registry unreachable; rolled back to 1.0.0',
    })
    expect(specs).toEqual(['dsh-ntr@1.1.0', 'dsh-ntr@1.1.0', 'dsh-ntr@1.0.0'])
  })

  it('removes the target before rolling back and reinstalls the running version without a registry', async () => {
    const installs: Array<{ spec: string; options?: { enabled?: boolean; registry?: string } }> = []
    const removes: string[] = []
    let installCount = 0
    const manager = managerWith({
      registries: async () => ({ registry: 'https://a.example/', fallbackRegistries: ['https://b.example'] }),
      installBundle: async (spec, options) => {
        installCount += 1
        installs.push({ spec, options })
        if (installCount === 1) return { application: 'failed', error: { code: 'already-installed' } }
        if (installCount === 2) return { application: 'failed', error: { code: 'EAI_AGAIN' } }
        return { application: 'restart-required', version: '1.0.0' }
      },
      removeBundle: async name => {
        removes.push(name)
        return { application: 'applied' }
      },
    })
    const fetchImpl = fetchFrom(url => url.startsWith('https://a.example')
      ? jsonResponse(packument(['1.0.0'], '1.0.0'))
      : jsonResponse(packument(['1.1.0'], '1.1.0')), [])
    const svc = service({ manager, fetchImpl })
    expect(await svc.check()).toMatchObject({ status: 'available', latest: '1.1.0' })
    expect(await svc.apply('1.1.0')).toEqual({
      status: 'failed',
      current: '1.0.0',
      installed: '1.0.0',
      message: 'installing 1.1.0 failed: EAI_AGAIN; rolled back to 1.0.0',
    })
    expect(removes).toEqual(['dsh-ntr', 'dsh-ntr'])
    expect(installs[0]).toEqual({ spec: 'dsh-ntr@1.1.0', options: { enabled: true, registry: 'https://b.example' } })
    expect(installs[2]).toEqual({ spec: 'dsh-ntr@1.0.0', options: { enabled: true } })
  })

  it('rolls back even when the pre-rollback removal throws', async () => {
    let installCount = 0
    let removes = 0
    const manager = managerWith({
      installBundle: async () => {
        installCount += 1
        if (installCount === 1) return { application: 'failed', error: { code: 'already-installed' } }
        if (installCount === 2) return { application: 'failed', error: { code: 'EAI_AGAIN' } }
        return { application: 'applied', version: '1.0.0' }
      },
      removeBundle: async () => {
        removes += 1
        if (removes === 2) throw new Error('bundle is not installed')
        return { application: 'applied' }
      },
    })
    expect(await service({ manager }).apply('1.1.0')).toMatchObject({
      status: 'failed',
      installed: '1.0.0',
    })
    expect(removes).toBe(2)
  })

  it('says so when the rollback itself fails', async () => {
    let installs = 0
    const manager = managerWith({
      installBundle: async () => {
        installs += 1
        if (installs === 1) return { application: 'failed', error: { code: 'already-installed' } }
        if (installs === 2) return { application: 'cancelled' }
        return { application: 'failed', error: { code: 'EACCES', diagnostic: 'locked' } }
      },
      removeBundle: async () => ({ application: 'applied' }),
    })
    const state = await service({ manager }).apply('1.1.0')
    expect(state).toMatchObject({ status: 'failed' })
    expect(state.installed).toBeUndefined()
    expect(state.message).toContain('installing 1.1.0 failed: the plugin manager answered cancelled')
    expect(state.message).toContain('rolling back to 1.0.0 also failed')
  })
})
