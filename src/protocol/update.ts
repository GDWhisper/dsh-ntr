/**
 * Built-in update reporting: the plugin's own release location and the states the host reports for it.
 *
 * Part of the protocol contract; the barrel is `src/protocol.ts` and every
 * existing `../protocol.ts` import keeps resolving through it. Pure types,
 * constants and pure helpers only — no side effects, no Node APIs, no ACP SDK
 * runtime values (type-only SDK imports are erased at build time).
 */

/** 本插件发布所在的 GitHub 仓库（发布说明只从这里读） */
export const PLUGIN_REPO = 'GDWhisper/dsh-ntr'

/** 某个版本的 GitHub 发布页；GitHub 不答时也能拼出来 */
export function pluginReleaseUrl(version: string): string {
  return `https://github.com/${PLUGIN_REPO}/releases/tag/v${version}`
}

/**
 * Where the plugin's own update check stands. The host half only ever reports
 * facts it can read from the harness plugin manager and the npm registry — it
 * never downloads, swaps files, or restarts itself.
 */
export type PluginUpdateStatus =
  | 'unsupported' | 'not-installed' | 'source-install' | 'managed'
  | 'current' | 'available' | 'applying' | 'busy'
  | 'applied' | 'restart-required' | 'failed'

/**
 * One update-check answer, shared by `plugin/update-check` and
 * `plugin/update-apply`.
 */
export interface PluginUpdateState {
  status: PluginUpdateStatus
  /** 运行中（内存里）的插件版本 */
  current: string
  /** 磁盘上装着的版本（listBundles().version），可读时才有 */
  installed?: string
  /** profile registry 链上最新的稳定版 */
  latest?: string
  /** latest 的 npm 发布时间 ISO */
  publishedAt?: string
  /** 实际按顺序问过的 registry */
  registries?: string[]
  /** 失败/额外说明（英文技术信息，UI 自己负责本地化） */
  message?: string
}

/**
 * 某个版本的发布说明（`plugin/release-notes`）。正文保持 GitHub Release 的
 * 原始形状：中文在前、单独一行 `---`、英文在后——选哪种语言是浏览器的事。
 */
export interface PluginReleaseNotes {
  version: string
  /** 发布页 URL，永远有（GitHub 没答也能拼出来） */
  url: string
  /** 原始发布正文（中文在前、单独一行 --- 分隔英文）；浏览器负责选语言 */
  body?: string
  /** 正文来源；none 表示只知道发布页 */
  source: 'github' | 'changelog' | 'none'
  /** 正文超长被截断，UI 自己翻提示 */
  truncated?: boolean
  /** 取不到正文的技术原因（英文），UI 只翻通用话 */
  message?: string
}
