import { defineConfig } from 'tsdown'

/**
 * Browser half → lib/client.js (the `/client` export).
 *
 * Mirrors the harness clientBundle preset (see dsh-web-startup-auth): DSH's
 * client-modules runtime is a lazy CJS loader — the artifact must register
 * itself through `window.__ModuleLoader__.load({ id, factory })` instead of
 * shipping bare ESM. react / cordis / ui-slots stay external because the
 * loader's module table answers them. The node half is built by `tsc`
 * (package.json `build` runs both).
 */
const BUNDLE_ID = 'dsh-ntr'

const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig({
  name: `${BUNDLE_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: EXTERNAL,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(BUNDLE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
