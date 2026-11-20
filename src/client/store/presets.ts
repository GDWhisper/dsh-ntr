/**
 * The fallback agent roster the settings page renders before the first
 * `agents/detect` round-trip. Hand copy of the host presets
 * (`src/bridge/state-paths.ts` `AGENT_PRESETS`): the two lists must stay in
 * sync (hard constraint 7). Split out of `src/client/store.ts` (split plan
 * P3a), which re-exports it unchanged.
 */

import type { DetectedAgentInfo } from "../../protocol.ts"

export const DEFAULT_KNOWN_PRESETS: DetectedAgentInfo[] = [
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    description: 'Automata / Pi Coding Agent with native ACP bridge support',
    detected: false,
    defaultCommand: 'pi-acp',
    defaultArgs: [],
  },
  {
    id: 'omp',
    name: 'Oh My Pi',
    description: 'Oh My Pi (pi-based coding agent) — run as `omp acp` over stdio',
    detected: false,
    defaultCommand: 'omp',
    defaultArgs: ['acp'],
  },
  // Hand copy of the host's `AGENT_PRESETS` entry (src/bridge.ts): the panel
  // falls back to this list before the first `agents/detect` round-trip.
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    description: 'Tencent CodeBuddy Code — run as `codebuddy --acp` over stdio',
    detected: false,
    defaultCommand: 'codebuddy',
    defaultArgs: ['--acp'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Claude Agent SDK adapter — run as `npx -y @agentclientprotocol/claude-agent-acp` over stdio',
    detected: false,
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex adapter — run as `npx -y @agentclientprotocol/codex-acp` over stdio',
    detected: false,
    defaultCommand: 'npx',
    defaultArgs: ['-y', '@agentclientprotocol/codex-acp'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode — run as `opencode acp` over stdio',
    detected: false,
    defaultCommand: 'opencode',
    defaultArgs: ['acp'],
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    description: 'Cursor CLI — run as `agent acp` over stdio (legacy alias `cursor-agent acp`)',
    detected: false,
    defaultCommand: 'agent',
    defaultArgs: ['acp'],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Qwen Code — run as `qwen --experimental-acp` over stdio',
    detected: false,
    defaultCommand: 'qwen',
    defaultArgs: ['--experimental-acp'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    description: 'Kiro CLI — run as `kiro-cli acp` over stdio',
    detected: false,
    defaultCommand: 'kiro-cli',
    defaultArgs: ['acp'],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    description: 'Qoder CLI — run as `qodercli --acp` over stdio',
    detected: false,
    defaultCommand: 'qodercli',
    defaultArgs: ['--acp'],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    description: 'Qoder CLI (China) — run as `qoderclicn --acp` over stdio',
    detected: false,
    defaultCommand: 'qoderclicn',
    defaultArgs: ['--acp'],
  },
  {
    id: 'agy',
    name: 'Antigravity CLI',
    description: 'Antigravity — run as `agy acp --dangerously-skip-permissions` over stdio',
    detected: false,
    defaultCommand: 'agy',
    defaultArgs: ['acp', '--dangerously-skip-permissions'],
  },
]
