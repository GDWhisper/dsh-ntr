/**
 * React surface for ACP: the settings configuration section.
 *
 * Scope is deliberately narrow — this is a CONFIGURATION surface. Runtime
 * interaction lives in the conversation: every permission ask with a chat
 * identity is answered on a card above that conversation's composer
 * (`permission-dock.tsx`). The ledger card here is the cross-session mirror —
 * asks whose conversation is not open, or which have no chat identity at all —
 * and is where those are answered (see `permissionLedgerCard`).
 *
 * Each configured agent is one compact row (status + current model + badges)
 * that expands into the full connection form and model catalog. The row stays
 * mounted and the body toggles `display`, so editing a form and collapsing it
 * never loses the in-progress values.
 * All business state lives in the injected AcpStore.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatCommandLine, isAbsolutePathLike, splitCommandLine } from './acp-ui.tsx'
import { DEFAULT_KNOWN_PRESETS, LOG_MAX_ENTRIES } from './store.ts'
import type { AcpStore, UiState } from './store.ts'
import { IDLE_RELEASE_MS } from '../protocol.ts'
import type { AcpAgentDef, AcpApprovalDeadlines, AcpCatalogChoice, AcpMcpServerDef, AgentSavePayload, AgentView, DetectedAgentInfo, PermissionTimeoutMode, PluginUpdateState } from '../protocol.ts'

interface WithStore { acp: AcpStore }

/**
 * Mirrors `AGENT_ID_PATTERN` in impl.ts — the client cannot import host-side
 * modules, so this copy must stay in sync (same deal as the preset copies,
 * constraint 7).
 */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Preset ids (drives the「自定义」badge); mirrors AGENT_PRESETS via store copies. */
const PRESET_IDS = new Set(DEFAULT_KNOWN_PRESETS.map(preset => preset.id))

/** Seed for the from-scratch creation card: no preset, no tested default. */
const NEW_AGENT_SEED: DetectedAgentInfo = {
  id: '',
  name: '',
  detected: false,
  defaultCommand: '',
  defaultArgs: [],
}

/** How long a chip edit is coalesced before the lightweight exposure RPC fires. */
const EXPOSURE_SAVE_DEBOUNCE_MS = 400

const STYLE = `
.dwa-root {
  --ntr-gap-1: 4px; --ntr-gap-2: 8px; --ntr-gap-3: 12px; --ntr-gap-4: 16px;
  --ntr-radius: 10px; --ntr-radius-sm: 7px;
  --ntr-font: 13px; --ntr-font-sm: 12px; --ntr-font-xs: 11px;
  --ntr-line: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  --ntr-muted: var(--dsw-alias-label-secondary, #6b7280);
  --ntr-danger: var(--dsw-alias-state-error-primary, #dc2626);
  --ntr-warn: var(--dsw-alias-state-warn-label, #b45309);
  --ntr-success: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a34a) 72%, var(--dsw-alias-label-primary, #111827));
  --ntr-accent: var(--dsw-alias-button-primary-fill, #2563eb);
  width: 100%; max-width: 960px; box-sizing: border-box; margin: 0 auto;
  padding: 28px 32px; min-width: 0; container-type: inline-size; font-size: var(--ntr-font); line-height: 1.55;
}
.dwa-root [hidden] { display: none !important; }
.dwa-root button, .dwa-root input, .dwa-root select, .dwa-root textarea { font-family: inherit; }
.dwa-root input, .dwa-root textarea { min-width: 0; }
.dwa-tabs { display: flex; gap: 24px; flex-wrap: wrap; border-bottom: var(--ntr-line); margin-bottom: 24px; }
.dwa-tabs > button { font: inherit; color: var(--ntr-muted); background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 0 0 12px; min-height: 40px; white-space: nowrap; cursor: pointer; }
.dwa-tabs > button:hover { color: var(--dsw-alias-label-primary, #111827); }
.dwa-tabs > button[aria-pressed="true"] { color: var(--dsw-alias-label-primary, #111827); border-bottom-color: currentColor; font-weight: 550; }
.dwa-detail-tabs { margin: 4px 0 20px; gap: 20px; }
.dwa-detail-tabs > button { font-size: var(--ntr-font-sm); }
.dwa-row-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dwa-notice { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.dwa-notice > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dwa-empty { text-align: center; padding: 40px 16px; color: var(--ntr-muted); }
.dwa-empty h3 { font-size: 16px; font-weight: 550; color: var(--dsw-alias-label-primary, #111827); margin: 0 0 8px; }
.dwa-empty .dwa-btn { margin-top: 20px; }
.dwa-health { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 24px; color: var(--ntr-muted); font-size: var(--ntr-font-sm); flex-wrap: wrap; }
.dwa-health-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dwa-health-status > span:last-child:not(:nth-child(2)) { padding-left: 12px; border-left: var(--ntr-line); }
.dwa-back { margin-bottom: 16px; }
.dwa-root button:focus-visible, .dwa-root input:focus-visible, .dwa-root select:focus-visible {
  outline: 2px solid var(--ntr-accent); outline-offset: 2px;
}
.dwa-page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
.dwa-page-heading { min-width: 0; }
.dwa-page-title { margin: 0; font-size: 20px; line-height: 1.35; font-weight: 550; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dwa-page-description { margin: 5px 0 0; color: var(--ntr-muted); font-size: var(--ntr-font-sm); }
.dwa-btn {
  min-height: 32px; box-sizing: border-box; font: inherit; border-radius: var(--ntr-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff);
  padding: 5px 12px; cursor: pointer; color: inherit; font-size: var(--ntr-font-sm);
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  white-space: nowrap; transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}
.dwa-btn:hover { background: var(--dsw-alias-interactive-bg-active, #f3f4f6); border-color: var(--dsw-alias-border-l1, #9ca3af); }
.dwa-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dwa-btn-primary { background: var(--ntr-accent); color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent; font-weight: 550; }
.dwa-btn-primary:hover { background: var(--ntr-accent); border-color: transparent; opacity: 0.88; }
.dwa-btn-secondary { background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.dwa-btn-quiet { background: transparent; border-color: transparent; color: var(--ntr-muted); }
.dwa-btn-quiet:hover { border-color: transparent; color: var(--dsw-alias-label-primary, #111827); }
.dwa-btn-danger { color: var(--ntr-danger); border-color: var(--dsw-alias-state-error-secondary, #fca5a5); }
.dwa-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger, #fee2e2); }
.dwa-section { margin-bottom: 24px; }
.dwa-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.dwa-section-title { font-size: 13px; font-weight: 550; margin: 0; display: flex; align-items: center; gap: 8px; }
.dwa-section-copy { margin: 3px 0 0; font-size: var(--ntr-font-xs); color: var(--ntr-muted); }
.dwa-card { border: var(--ntr-line); border-radius: var(--ntr-radius); padding: 16px; background: var(--dsw-alias-bg-layer-1, #fff); font-size: var(--ntr-font); line-height: 1.55; }
.dwa-card-warn { border-color: color-mix(in srgb, var(--ntr-warn) 30%, var(--dsw-alias-border-l2, #e5e7eb)); background: var(--dsw-alias-state-warn-tertiary, #fffbeb); }
.dwa-mode-banner { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 16px; align-items: start; margin-bottom: 24px; padding: 14px 16px; }
.dwa-mode-title { display: flex; align-items: center; gap: 8px; font-weight: 650; }
.dwa-mode-copy { grid-column: 1 / -1; color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
.dwa-mode-source { display: block; margin-top: 5px; overflow-wrap: anywhere; opacity: 0.85; }
.dwa-badge { font-size: var(--ntr-font-xs); line-height: 1.4; border-radius: 999px; padding: 2px 8px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--ntr-muted); font-weight: 550; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.dwa-badge-success { background: var(--dsw-alias-state-success-tertiary, #dcfce7); color: var(--ntr-success); }
.dwa-badge-warn { background: var(--dsw-alias-state-warn-tertiary, #fef3c7); color: var(--ntr-warn); }
.dwa-badge-info { background: var(--dsw-alias-state-business-tertiary, #dbeafe); color: var(--dsw-alias-state-business-primary, #2563eb); }
/* The update badge is a button (it expands the update card): strip the
   browser's default button chrome, keep the badge look. */
.dwa-update-badge { border: 0; font-family: inherit; cursor: pointer; }
.dwa-update-badge:hover { opacity: 0.85; }
/* The version badge doubles as the update entry: same badge look, no chrome. */
.dwa-version-btn { border: 0; font-family: inherit; cursor: pointer; }
.dwa-version-btn:hover { opacity: 0.85; }
.dwa-version { font-family: var(--ds-font-family-code, monospace); }
/* The update card sits between the page header and the permission mirror. */
.dwa-update-card { margin-bottom: 16px; }
.dwa-update-summary { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-weight: 550; }
.dwa-update-copy { margin: 6px 0 0; color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
.dwa-update-message { margin: 6px 0 0; color: var(--ntr-muted); font-size: var(--ntr-font-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.dwa-update-actions { margin-top: 10px; }
.dwa-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.dwa-agent-list { display: flex; flex-direction: column; border-top: var(--ntr-line); }
.dwa-agent-card { border-bottom: var(--ntr-line); min-width: 0; }
.dwa-agent-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 16px 0; }
.dwa-agent-avatar { display: grid; place-items: center; width: 38px; height: 38px; border: var(--ntr-line); border-radius: 9px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--ntr-muted); font: 12px var(--ds-font-family-code, monospace); }
.dwa-caret { font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; width: 1em; }
.dwa-caret-btn { font: inherit; border: none; background: var(--dsw-alias-bg-layer-2, #f3f4f6); width: 28px; height: 28px; padding: 0; border-radius: var(--ntr-radius-sm); display: inline-flex; align-items: center; justify-content: center; color: var(--ntr-muted); cursor: pointer; }
.dwa-caret-btn:hover { background: var(--dsw-alias-interactive-bg-active, #e5e7eb); color: inherit; }
.dwa-agent-summary { min-width: 0; }
.dwa-agent-titleline { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.dwa-agent-name { font-size: 13px; font-weight: 550; overflow-wrap: anywhere; }
.dwa-agent-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
.dwa-agent-meta-separator { opacity: 0.45; }
.dwa-agent-body { padding: 0 0 24px 52px; }
.dwa-subsection { min-width: 0; }
.dwa-form-row { display: flex; gap: var(--ntr-gap-3); margin-bottom: 14px; align-items: stretch; }
.dwa-form-col { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dwa-form-label { font-size: var(--ntr-font-sm); font-weight: 600; color: var(--dsw-alias-label-primary, #374151); }
.dwa-hint { font-size: var(--ntr-font-xs); line-height: 1.55; color: var(--ntr-muted); }
.dwa-error { font-size: var(--ntr-font-xs); color: var(--ntr-danger); }
.dwa-input { min-height: 36px; font: inherit; font-size: var(--ntr-font-sm); padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; width: 100%; box-sizing: border-box; }
.dwa-select { min-height: 32px; font: inherit; font-size: var(--ntr-font-sm); padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.dwa-input:hover, .dwa-select:hover { border-color: var(--dsw-alias-border-l1, #9ca3af); }
.dwa-input:focus, .dwa-select:focus { border-color: var(--ntr-accent); }
.dwa-input-mono, .dwa-mono { font-family: var(--ds-font-family-code, ui-monospace), SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.dwa-stderr { max-height: 120px; overflow: auto; font-family: monospace; font-size: var(--ntr-font-xs); white-space: pre-wrap; color: var(--ntr-warn); margin: 12px 0 0; }
.dwa-default-hint { background: var(--dsw-alias-bg-layer-2, #f9fafb); border: var(--ntr-line); border-radius: var(--ntr-radius-sm); padding: 10px 12px; font-size: var(--ntr-font-sm); display: flex; align-items: center; justify-content: space-between; margin: 12px 0 14px; gap: 12px; }
.dwa-form-actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: var(--ntr-line); flex-wrap: wrap; }
.dwa-form-actions .dwa-btn-primary { min-width: 88px; }
.dwa-form-actions > .dwa-hint:first-child { margin-right: auto; }
.dwa-form-actions > .dwa-hint:last-child:not(:first-child) { width: 100%; }
.dwa-menu-wrap { position: relative; }
.dwa-menu-wrap > .dwa-btn { width: 32px; padding: 0; }
.dwa-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 190px; border: var(--ntr-line); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); padding: 4px; display: flex; flex-direction: column; }
.dwa-menu-item { font: inherit; font-size: var(--ntr-font-sm); text-align: left; border: none; background: none; padding: 7px 10px; border-radius: 5px; cursor: pointer; color: inherit; }
.dwa-menu-item:hover { background: var(--dsw-alias-interactive-bg-active, #f3f4f6); }
.dwa-menu-item-danger { color: var(--ntr-danger); }
.dwa-menu-confirm { display: flex; align-items: center; gap: 4px; padding: 4px; }
.dwa-add-panel .dwa-agent-row { display: none; }
.dwa-add-panel .dwa-agent-body { padding: 0 0 24px; }
.dwa-add-panel .dwa-agent-card { border: 0; }
.dwa-add-content { padding-top: 10px; }
.dwa-chip { min-height: 30px; font: inherit; font-size: var(--ntr-font-sm); border: var(--ntr-line); border-radius: 999px; padding: 4px 12px; background: var(--dsw-alias-bg-layer-1, #fff); cursor: pointer; color: inherit; }
.dwa-chip:hover { background: var(--dsw-alias-interactive-bg-active, #f3f4f6); }
.dwa-chip-active { border-color: var(--ntr-accent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 8%, transparent); color: var(--dsw-alias-state-business-primary, #2563eb); font-weight: 550; }
.dwa-chip-list { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 0 0 12px; }
.dwa-switch { display: inline-flex; align-items: center; gap: 7px; font-size: var(--ntr-font-sm); cursor: pointer; user-select: none; }
.dwa-inline-setting { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-2, #f9fafb); }
.dwa-inline-setting .dwa-switch { flex-shrink: 0; margin-top: 1px; }
.dwa-setting-copy { color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
/* Stacked, not side by side: the rows carry name, id and credit, and a
   half-width pane truncated them at every realistic settings width. Each list
   gets the whole column instead. */
.dwa-model-transfer { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
/* Tall enough for a comfortable selection (about ten rows) before scrolling;
   the cap keeps the two stacked panes from pushing the rest of the card away. */
.dwa-model-pane { min-width: 0; max-height: 360px; display: flex; flex-direction: column; border: var(--ntr-line); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.dwa-model-pane-head { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: var(--ntr-line); font-size: var(--ntr-font-xs); font-weight: 600; color: var(--dsw-alias-label-secondary, #4b5563); }
.dwa-model-pane-head .dwa-btn { margin-left: auto; min-height: 26px; padding: 2px 8px; font-size: var(--ntr-font-xs); }
.dwa-model-pane-head .dwa-caret-btn { flex: none; width: 22px; height: 22px; background: transparent; }
.dwa-model-pane-head .dwa-caret-btn:hover { background: var(--dsw-alias-interactive-bg-active, #e5e7eb); }
.dwa-model-pane.is-collapsed .dwa-model-list { display: none; }
.dwa-model-list { display: flex; flex-direction: column; gap: 2px; padding: 5px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.dwa-model-section { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.dwa-model-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* The actions group keeps 「检测可用模型」 and the filter together and wraps as
   one unit; the status line takes the leftover space on the first row, so a
   narrow panel puts [detect][search] on its own row starting under the label
   instead of floating them to the right edge. */
.dwa-model-toolbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dwa-model-status { margin-left: auto; white-space: nowrap; }
.dwa-model-search { width: 200px; min-height: 30px; }
.dwa-model-empty { padding: 6px; }
.dwa-model-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 38px; border: none; background: none; padding: 7px 8px; border-radius: 5px; cursor: pointer; color: inherit; font: inherit; font-size: var(--ntr-font-sm); text-align: left; }
.dwa-model-row:hover { background: var(--dsw-alias-interactive-bg-active, #f3f4f6); }
.dwa-model-row.is-on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #2563eb) 8%, transparent); color: var(--dsw-alias-state-business-primary, #2563eb); }
.dwa-model-row-mark { width: 12px; flex: none; text-align: center; opacity: 0.75; }
.dwa-model-row-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Name and credit keep their room; the id is the only cell that collapses. */
.dwa-model-row-desc { flex: 0 0 auto; max-width: 45%; opacity: 0.75; font-size: var(--ntr-font-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The trailing 14px is reserved for the fade mask: while the id fits, the
   gradient only covers empty padding; once it overflows, its tail dissolves
   instead of ending in a hard ellipsis. armModelIdMarquee reads the same
   padding to scroll the full text under the pointer. */
.dwa-model-row-value { flex: 0 1 auto; flex-shrink: 1000; box-sizing: border-box; min-width: 0; max-width: 45%; padding-right: 14px; opacity: 0.55; font-size: 10px; overflow: hidden; white-space: nowrap; mask-image: linear-gradient(to right, #000 calc(100% - 14px), transparent); -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 14px), transparent); }
.dwa-model-row-value-text { display: inline-block; white-space: nowrap; }
.dwa-model-row:hover .dwa-model-row-value-text { animation: dwa-model-id-marquee var(--dwa-id-duration, 1.4s) ease-in-out 0.2s infinite alternate; }
@keyframes dwa-model-id-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(var(--dwa-id-shift, 0px)); }
}
.dwa-model-row-remove { flex: none; opacity: 0.5; padding: 0 2px; }
.dwa-model-row:hover .dwa-model-row-remove { opacity: 1; }
.dwa-seg { display: inline-flex; gap: 4px; padding: 4px; box-sizing: border-box; border-radius: var(--ntr-radius-sm); border: var(--ntr-line); background: var(--dsw-alias-bg-layer-2, #f3f4f6); vertical-align: middle; }
.dwa-seg > button { min-height: 32px; font: inherit; font-size: var(--ntr-font-sm); color: var(--ntr-muted); border: 1px solid transparent; border-radius: 4px; background: transparent; padding: 4px 12px; cursor: pointer; white-space: nowrap; }
.dwa-seg > button:hover { background: var(--dsw-alias-interactive-bg-active, #f3f4f6); }
.dwa-seg > button.is-on { background: var(--dsw-alias-bg-layer-1, #fff); border: var(--ntr-line); color: var(--dsw-alias-label-primary, #111827); font-weight: 550; }
.dwa-preferences { border-top: var(--ntr-line); }
.dwa-preference-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 0; }
.dwa-preference-row + .dwa-preference-row { border-top: var(--ntr-line); }
/* A control that needs the whole card: the label sits above it, not beside
   it. A right-aligned segmented control squeezed its labels into two lines
   each (中/止, 自动推/进), which read as broken rather than as choices. */
.dwa-preference-block { padding: 12px 0; }
.dwa-preference-block + .dwa-preference-block { border-top: var(--ntr-line); }
.dwa-preference-label { font-size: var(--ntr-font-sm); font-weight: 600; }
.dwa-preference-copy { margin-top: 2px; color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
.dwa-seg-wide { display: flex; width: 100%; margin-top: 10px; }
.dwa-seg-wide > button { flex: 1; }
/* The wait window, as a slider: the number is the headline, the rungs are the
   scale under the track. */
.dwa-deadline-value { margin-top: 8px; font-size: 20px; font-weight: 600; }
.dwa-deadline-range { width: 100%; margin-top: 6px; accent-color: var(--ntr-accent); }
.dwa-deadline-range:disabled { opacity: 0.4; }
.dwa-deadline-ticks { display: flex; justify-content: space-between; margin-top: 2px; color: var(--ntr-muted); font-size: 10px; }
.dwa-deadline-ticks > span { white-space: nowrap; }
/* The facts that make a number here meaningless, in warning ink rather than
   the muted gray every other hint uses: the value the config file is
   outranking, on the row it belongs to. */
.dwa-deadline-flag { margin-top: 4px; font-size: var(--ntr-font-xs); font-weight: 550; color: var(--ntr-warn); }
.dwa-deadline-warn { margin-top: 10px; padding: 9px 12px; border-left: 3px solid var(--dsw-alias-state-warn-primary, #d97706); background: var(--dsw-alias-state-warn-secondary, #fffbeb); border-radius: var(--ntr-radius-sm); font-size: var(--ntr-font-xs); line-height: 1.55; }
.dwa-deadline-reset { display: flex; justify-content: flex-end; margin-top: 8px; }
/* Runtime log: one bounded list, newest first. The time column never wraps;
   the message is the only cell that may break anywhere. */
.dwa-log-list { list-style: none; margin: 0; padding: 0; border: var(--ntr-line); border-radius: var(--ntr-radius); overflow: hidden; }
.dwa-log-row { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; font-size: var(--ntr-font-sm); border-top: var(--ntr-line); min-width: 0; }
.dwa-log-row:first-child { border-top: 0; }
.dwa-log-row.is-error { background: var(--dsw-alias-state-error-tertiary, #fef2f2); }
.dwa-log-time { color: var(--ntr-muted); white-space: nowrap; }
.dwa-log-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dwa-log-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ntr-danger); display: inline-block; margin-left: 6px; }
.dwa-log-level.is-info { background: var(--dsw-alias-state-business-tertiary, #dbeafe); color: var(--dsw-alias-state-business-primary, #2563eb); }
.dwa-log-level.is-error { background: var(--dsw-alias-state-error-tertiary, #fef2f2); color: var(--ntr-danger); }
@media (max-width: 640px) {
  .dwa-root { padding: 20px 16px; }
}
@container (max-width: 640px) {
  .dwa-page-header { align-items: flex-start; flex-wrap: wrap; }
  .dwa-agent-body { padding-left: 0; }
  .dwa-agent-row { grid-template-columns: 32px minmax(0, 1fr) auto; gap: 10px; }
  .dwa-agent-avatar { width: 32px; height: 32px; }
  .dwa-section-heading { flex-wrap: wrap; }
  .dwa-tabs { gap: 20px; }
  .dwa-notice { flex-wrap: wrap; }
  .dwa-seg-wide > button { padding-inline: 5px; }
  .dwa-model-toolbar-actions { width: 100%; }
  .dwa-model-search { flex: 1 1 auto; width: auto; }
  .dwa-preference-row { align-items: flex-start; flex-direction: column; }
  .dwa-default-hint { align-items: flex-start; flex-direction: column; }
  /* The slider's scale: up to eight rungs with full unit words ("15 分钟")
     need a smaller face before they can collide on a narrow panel. The rung
     count follows the mode (自动推进 adds 不等待), and the row is a flex
     space-between, so a shorter scale just spreads wider. */
  .dwa-deadline-ticks { font-size: 9px; }
}
@media (prefers-reduced-motion: reduce) {
  .dwa-root *, .dwa-root *::before, .dwa-root *::after { transition: none !important; }
  .dwa-model-row:hover .dwa-model-row-value-text { animation: none !important; }
}
`

let styleMounted = false
function ensureStyle(): void {
  if (styleMounted || typeof document === 'undefined') return
  styleMounted = true
  const node = document.createElement('style')
  node.textContent = STYLE
  document.head.appendChild(node)
}

function useUi(acp: AcpStore) {
  return useSyncExternalStore(cb => acp.subscribe(cb), () => acp.getSnapshot())
}

function stateVisual(state: AgentView['state'], acp: AcpStore): { color: string; text: string; title?: string } {
  switch (state) {
    case 'ready': return { color: 'var(--dsw-alias-state-success-primary, #22c55e)', text: acp.label('已连接', 'Connected') }
    case 'starting': return { color: 'var(--dsw-alias-state-warn-primary, #eab308)', text: acp.label('启动中', 'Starting') }
    case 'error': return { color: 'var(--dsw-alias-state-error-primary, #ef4444)', text: acp.label('错误', 'Error') }
    // A configured-but-resting agent is the normal state, not a fault: the
    // process is not kept resident and connects on demand the first time a DSH
    // chat turn uses it. Surfacing a runtime lifecycle here ("stopped"/"idle")
    // read as broken; the user's real question at a glance is "is it set up?",
    // which the config-time 测试连接 (agent/test) already answers. So the
    // resting state just says 已配置.
    default: return {
      color: 'var(--dsw-alias-state-idle-primary, #9ca3af)',
      text: acp.label('已配置', 'Configured'),
      title: acp.label(
        '已配置，进程不常驻。在 DSH 聊天中首次使用时自动连接；展开区可用「测试连接」验证命令能否正常起来。',
        'Configured; the process is not kept resident. It connects automatically the first time a DSH chat turn uses it — use “Test connection” in the expanded panel to verify the command starts.',
      ),
    }
  }
}

/** Bilingual label for the event-stream state shown in the toolbar. */
function streamText(stream: 'init' | 'live' | 'down', acp: AcpStore): string {
  if (stream === 'live') return acp.label('事件流已连接', 'Event stream live')
  if (stream === 'down') return acp.label('事件流已断开', 'Event stream down')
  return acp.label('事件流连接中', 'Event stream connecting')
}

/**
 * Canonical comparable form of an exposure filter. Unset and empty mean the
 * same thing host-side (no `agentId@choice` variants), so they share a key —
 * treating them as different would leave a row permanently dirty.
 */
function exposureKey(exposed: readonly string[] | undefined): string {
  return exposed === undefined || exposed.length === 0 ? 'none' : `set:${exposed.join('\u0000')}`
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameStringMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/**
 * Canonical comparable form of the MCP server list. Unset and empty mean the
 * same thing host-side (no extra MCP servers), so they share a key — treating
 * them as different would leave a card permanently dirty.
 *
 * The list is compared by CANONICAL JSON (object keys sorted, the servers
 * themselves sorted by name): reformatting the text — reordering keys,
 * re-indenting, listing the servers in another order — is not a change. The
 * ARGV array inside a server keeps its order, because there it is the command
 * line. The browser half needs no copy of the host's per-server validation: a
 * list the host would reject simply never matches, and the host's own error is
 * what the user sees.
 */
function mcpKey(servers: readonly AcpMcpServerDef[] | undefined): string {
  if (servers === undefined || servers.length === 0) return 'none'
  const canonical = servers
    .map(canonicalJson)
    .sort((a, b) => {
      const nameA = String((a as { name?: unknown }).name ?? '')
      const nameB = String((b as { name?: unknown }).name ?? '')
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0
    })
  return JSON.stringify(canonical)
}

/** One value in canonical JSON form: object keys sorted, arrays kept in order. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => [key, canonicalJson(entry)])
  return Object.fromEntries(entries)
}

/**
 * The MCP server list as the form holds it: the raw JSON text the user typed.
 *
 * Parsing happens on the way OUT (`buildPayload`), never on the way in, so a
 * half-typed value never throws inside a render. An unparseable text yields
 * `undefined`, which the form reports as invalid (`mcpInvalid`) and refuses to
 * save — better than sending a truncated list.
 */
function parseMcpServers(text: string): AcpMcpServerDef[] | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return undefined
    return parsed as AcpMcpServerDef[]
  } catch {
    return undefined
  }
}

/** Whether the MCP server text parses as a list at all (the host validates the rest). */
function mcpTextValid(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  try {
    return Array.isArray(JSON.parse(trimmed))
  } catch {
    return false
  }
}

/**
 * Detected presets split by configured-ness, plus configured agents missing
 * from detection (custom / legacy persisted defs) synthesized into card
 * entries so they stay manageable.
 */
function partitionAgents(
  detectedAgents: readonly DetectedAgentInfo[],
  agents: readonly AgentView[],
): { configured: Array<{ info: DetectedAgentInfo; synthesized: boolean }>; available: DetectedAgentInfo[] } {
  const configured: Array<{ info: DetectedAgentInfo; synthesized: boolean }> = []
  const available: DetectedAgentInfo[] = []
  const agentIds = new Set(agents.map(a => a.id))
  const detectedIds = new Set(detectedAgents.map(d => d.id))
  for (const info of detectedAgents) {
    if (agentIds.has(info.id) || info.currentConfig !== undefined) configured.push({ info, synthesized: false })
    else available.push(info)
  }
  for (const agent of agents) {
    if (!detectedIds.has(agent.id)) {
      configured.push({
        info: {
          id: agent.id,
          name: agent.title,
          detected: false,
          defaultCommand: agent.command,
          defaultArgs: [...agent.args],
        },
        synthesized: true,
      })
    }
  }
  return { configured, available }
}

/**
 * The persisted definition a save would replace. `currentConfig` is the full
 * def (env / npmPackage / exposedModels included); the synthesized fallback
 * covers only the fields an `AgentView` carries, so anything else compares as
 * "changed" — the honest answer when the host never reported it.
 *
 * The idle-release field is compared AS STORED: an absent per-agent field
 * means "follow the global window", and the host's resolved value must not be
 * written back into it — that would freeze the global window into this agent's
 * definition and the global slider would then never reach it.
 */
function persistedDef(detected: DetectedAgentInfo, activeAgent: AgentView | undefined): AcpAgentDef | undefined {
  if (detected.currentConfig !== undefined) return detected.currentConfig
  if (activeAgent === undefined) return undefined
  return {
    id: activeAgent.id,
    title: activeAgent.title,
    command: activeAgent.command,
    args: [...activeAgent.args],
    ...(activeAgent.cwd === undefined ? {} : { cwd: activeAgent.cwd }),
    allowedCwdRoots: [...activeAgent.allowedCwdRoots],
    env: {},
  }
}

/**
 * Equivalence test between the form payload and what is already persisted.
 * Order-insensitive on purpose: `env` is a map and `args`/`allowedCwdRoots`
 * keep their order, but a reordered allow-list is not a change worth warning
 * about; `exposedModels === undefined` means "offer no variants", which is the
 * same state as an empty list.
 */
export function payloadEquals(payload: AgentSavePayload, current: AcpAgentDef): boolean {
  if (payload.command !== current.command) return false
  if ((payload.title ?? payload.id) !== (current.title ?? current.id)) return false
  if (!sameStringArray(payload.args ?? [], current.args ?? [])) return false
  if ((payload.npmPackage ?? '') !== (current.npmPackage ?? '')) return false
  if ((payload.cwd ?? '') !== (current.cwd ?? '')) return false
  if (!sameStringArray(payload.allowedCwdRoots ?? [], current.allowedCwdRoots ?? [])) return false
  if (!sameStringMap(payload.env ?? {}, current.env ?? {})) return false
  if (exposureKey(payload.exposedModels) !== exposureKey(current.exposedModels)) return false
  if (mcpKey(payload.mcpServers) !== mcpKey(current.mcpServers)) return false
  if ((payload.autoDiscoverModels !== false) !== (current.autoDiscoverModels !== false)) return false
  // The per-agent OVERRIDE, compared as stored: an absent field on both sides
  // means "follow the global window" and is not a change; a field on one
  // side only means the user is adding or dropping an override.
  if (payload.idleTimeoutMs !== current.idleTimeoutMs) return false
  return true
}

/**
 * The settings panel's permission-ledger rule.
 *
 * Pending asks are shown in the conversation card while that conversation is
 * open; this card is the cross-session mirror for the ones it cannot show —
 * asks belonging to another conversation, and `/acp` RPC-only asks with no
 * chat identity at all. It therefore appears whenever ANY ask is pending: a
 * pending entry with no conversation card would otherwise have no answer
 * surface anywhere.
 */
export function permissionLedgerCard(ui: Pick<UiState, 'permissions'>): { visible: boolean } {
  return { visible: ui.permissions.length > 0 }
}

/**
 * The ONE wait window, as the rungs the slider snaps to.
 *
 * Shortest wait first, and `0` (不等待) FIRST: the slider reads left to right
 * as "wait longer", and "do not wait at all" is the shortest wait there is.
 * Never expiring is NOT on this scale — that is the `wait` MODE's business,
 * and having 「一直等待」 in both places made the card say the same thing twice
 * in two ways.
 *
 * A window the config file names that is not on this ladder (45 seconds, say)
 * still runs as configured: the card prints the exact number and parks the
 * thumb on the nearest rung, so the slider never pretends a number the host
 * is not using.
 */
const DEADLINE_LADDER: readonly number[] = [
  0,
  30_000,
  60_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000,
  21_600_000,
]

/**
 * The shortest REAL wait — the first rung above 不等待.
 *
 * Hand-copied from the host half (`APPROVAL_DEADLINE_MIN_WAIT_MS` in
 * `src/impl.ts`): the browser half may not import the host module, so the
 * equivalence is pinned by a test instead (see `tests/acp-view.spec.ts`).
 */
export const DEADLINE_MIN_WAIT_MS = 30_000

/**
 * The window the card shows under a mode.
 *
 * 不等待 (`0`) is the **auto** mode's rung: it answers with the option the
 * agent's own kinds imply, so the agent CONTINUES. `abort` has no such rung —
 * refusing every ask the instant it arrives stops the agent at every gate it
 * meets, which is not a timeout but a wall. So under `abort` the window floors
 * to the shortest real wait, and the card never shows a zero it cannot run.
 *
 * `undefined` (the `wait` mode) stays undefined: there is no window at all.
 */
export function deadlineValueFor(mode: PermissionTimeoutMode, ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined
  return mode === 'abort' ? Math.max(ms, DEADLINE_MIN_WAIT_MS) : ms
}

/**
 * The rungs a mode offers.
 *
 * 不等待 (`0`) is the **auto** mode's rung: it answers with the option the
 * agent's own kinds imply, so the agent CONTINUES. `abort` has no such rung —
 * refusing every ask the instant it arrives stops the agent at every gate it
 * meets, which is not a timeout but a wall. So `abort` starts at the shortest
 * real wait.
 */
function deadlineLadder(mode: PermissionTimeoutMode): readonly number[] {
  return mode === 'auto' ? DEADLINE_LADDER : DEADLINE_LADDER.filter(ms => ms > 0)
}

/**
 * The rung the slider shows for a window. Exact hits keep their rung; anything
 * else takes the nearest one. A tie goes to the SHORTER wait: the thumb must
 * never promise more patience than the window has.
 */
export function deadlineSliderIndex(ms: number, mode: PermissionTimeoutMode = 'auto'): number {
  const ladder = deadlineLadder(mode)
  const exact = ladder.indexOf(ms)
  if (exact >= 0) return exact
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < ladder.length; i++) {
    const distance = Math.abs(ms - ladder[i])
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/** The three modes, in the order a user reads them: refuse, answer, wait. */
const DEADLINE_MODES: readonly PermissionTimeoutMode[] = ['abort', 'auto', 'wait']

/** `5 分钟` / `30 秒` / `不等待` — the readout and the tick label, one formatter. */
function deadlineText(ms: number, acp: AcpStore): string {
  if (ms <= 0) return acp.label('不等待', 'No wait')
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return acp.label(`${String(seconds)} 秒`, `${String(seconds)}s`)
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return acp.label(`${String(minutes)} 分钟`, `${String(minutes)}m`)
  const hours = Math.round(minutes / 60)
  return acp.label(`${String(hours)} 小时`, `${String(hours)}h`)
}

/** The mode's label — one formatter, so the picker and the override note agree. */
function modeText(mode: PermissionTimeoutMode, acp: AcpStore): string {
  if (mode === 'abort') return acp.label('超时中止', 'Abort')
  if (mode === 'auto') return acp.label('自动推进', 'Auto')
  return acp.label('一直等待', 'Wait')
}

/**
 * The mode block: what happens when nobody answers.
 *
 * Three values and no more — refuse, answer, wait — so the picker is a
 * segmented control, not a dropdown. The buttons stretch across the whole
 * card: a right-aligned segmented control squeezed the labels into two lines
 * each (中/止, 自动推/进), which read as broken rather than as choices.
 *
 * The copy under the buttons says what the SELECTED mode does, in one
 * sentence — the labels alone ("超时中止") cannot. `auto` carries a warning of
 * its own: it approves things nobody looked at.
 */
function DeadlineModeBlock(props: {
  acp: AcpStore
  mode: PermissionTimeoutMode
  /** Set when the deployment baseline is outranked here. */
  override?: string
}) {
  const { acp, mode, override } = props
  const copy = mode === 'wait'
    ? acp.label(
      '一直等待应答，不设超时时间。',
      'Wait until you answer — no deadline.',
    )
    : mode === 'auto'
      ? acp.label(
        '超过设定时间未应答，自动代替你选择一个选项让 agent 继续执行。',
        'Past the deadline, an option is chosen for you and the agent continues.',
      )
      : acp.label(
        '超过设定时间未应答，自动拒绝该操作，agent 继续执行。',
        'Past the deadline, the operation is refused and the agent continues.',
      )
  return (
    <div className="dwa-preference-block">
      <div className="dwa-preference-label">{acp.label('超时处理方式', 'When nobody answers')}</div>
      <div className="dwa-seg dwa-seg-wide">
        {DEADLINE_MODES.map(option => (
          <button
            key={option}
            type="button"
            className={mode === option ? 'is-on' : ''}
            onClick={() => void acp.setApprovalTimeoutMode(option)}
          >
            {modeText(option, acp)}
          </button>
        ))}
      </div>
      <div className="dwa-preference-copy">{copy}</div>
      {mode === 'auto' && (
        <div className="dwa-deadline-warn">
          {acp.label(
            '请确保你的 agent 值得信任，请谨慎选择。',
            'Only pick this if you trust your agent — choose it carefully.',
          )}
        </div>
      )}
      {override !== undefined && (
        <div className="dwa-deadline-flag">⚠ {override}</div>
      )}
    </div>
  )
}

/**
 * The duration block: how long to wait before the deadline fires.
 *
 * ONE slider, because there is ONE window: an ask in the conversation and an
 * ask in the settings ledger are the same question, so they get the same
 * answer. The slider's rungs are the windows people actually pick; a window
 * the config file names outside them still runs as configured (the readout
 * prints the exact number and the thumb parks on the nearest rung).
 *
 * `value === undefined` is the `wait` mode: there is no deadline at all, so
 * the scale has nothing to say — the slider is not drawn, and the readout
 * names the state that is actually in force. The stored window is NOT touched
 * by that (the mode write carries only the mode), so switching back restores
 * it.
 */
function DeadlineSliderBlock(props: {
  acp: AcpStore
  /** undefined in `wait` mode: no window, so no scale. */
  value: number | undefined
  /** The mode the window runs under — it decides which rungs exist. */
  mode: PermissionTimeoutMode
  /** Set when the deployment baseline is outranked here. */
  override?: string
}) {
  const { acp, value, mode, override } = props
  // 不等待 belongs to `auto`. Under `abort` the window floors to the shortest
  // real wait, so the card never shows a zero it cannot run.
  const effective = deadlineValueFor(mode, value)
  const ladder = deadlineLadder(mode)
  const index = effective === undefined ? 0 : deadlineSliderIndex(effective, mode)
  const copy = effective === undefined
    ? acp.label(
      '选择「一直等待」时不设超时时长。',
      '“Wait” sets no deadline.',
    )
    : effective <= 0
      ? acp.label(
        '不设等待时间，请求到达即按上方所选的方式处理。',
        'No wait: the ask is settled on arrival, by whatever you picked above.',
      )
      : acp.label(
        '超过该时长仍未应答，将按上方所选的方式处理。',
        'Past this, whatever you picked above is what happens.',
      )
  return (
    <div className="dwa-preference-block">
      <div className="dwa-preference-label">{acp.label('等待时长', 'How long to wait')}</div>
      <div className="dwa-deadline-value">
        {effective === undefined ? acp.label('一直等待', 'Always') : deadlineText(effective, acp)}
      </div>
      {effective !== undefined && (
        <>
          <input
            className="dwa-deadline-range"
            type="range"
            min={0}
            max={ladder.length - 1}
            step={1}
            value={index}
            aria-label={acp.label('等待时长', 'How long to wait')}
            onChange={event => {
              const next = ladder[Number(event.target.value)]
              if (next !== undefined && next !== effective) void acp.setApprovalDeadline(next)
            }}
          />
          <div className="dwa-deadline-ticks">
            {ladder.map(rung => (
              <span key={rung}>{deadlineText(rung, acp)}</span>
            ))}
          </div>
        </>
      )}
      <div className="dwa-preference-copy">{copy}</div>
      {override !== undefined && (
        <div className="dwa-deadline-flag">⚠ {override}</div>
      )}
    </div>
  )
}

/**
 * The facts the card has to show, decided from what the host reported.
 *
 * The card carries TWO controls, and they are orthogonal: one window (how
 * long) and one mode (what happens). An override can sit on either of them,
 * so each is decided on its own.
 *
 * `overridden` is what gates the reset button. A baseline that AGREES with the
 * running value is not an override, and offering a reset for it would be a
 * button that does nothing (observed live).
 */
export function approvalDeadlineFacts(deadlines: AcpApprovalDeadlines): {
  /** The config-file window the card's window outranks — undefined when
   *  nothing is being outranked. */
  baseline: number | undefined
  /** The config-file mode the card's mode outranks, when it differs. */
  modeBaseline: PermissionTimeoutMode | undefined
  /** A reset is only honest when something is actually being outranked. */
  overridden: boolean
} {
  const configured = deadlines.configured?.permissionTimeoutMs
  const baseline = configured === undefined || configured === deadlines.permissionTimeoutMs
    ? undefined
    : configured
  const modeBaseline = deadlines.configuredMode !== undefined && deadlines.configuredMode !== deadlines.mode
    ? deadlines.configuredMode
    : undefined
  return {
    baseline,
    modeBaseline,
    overridden: baseline !== undefined || modeBaseline !== undefined,
  }
}

/**
 * The approval-deadline card.
 *
 * TWO controls, and they are orthogonal: one window (how long) and one mode
 * (what happens). One window covers both places an ask can wait — the
 * conversation's approval card and the settings panel's ledger — because they
 * ask the same question and the answer should not differ by where the card
 * happens to be drawn.
 *
 * The two controls are ONE system, and the card says so in a sentence: the
 * window says how long to wait, the mode says what happens when nobody
 * answered. That sentence is the thing the previous three-row layout kept
 * missing.
 *
 * The facts that make a number here meaningless are shown, not swallowed: the
 * deployment baseline this card outranks. Each rides on the control it belongs
 * to, and the reset button appears only when something is actually being
 * outranked.
 */
function ApprovalDeadlinesCard(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const deadlines = ui.approvalDeadlines
  // Older host half: no card rather than a number this browser invented.
  if (deadlines === undefined) return null
  const facts = approvalDeadlineFacts(deadlines)
  const baselineNote = facts.baseline === undefined
    ? undefined
    : acp.label(
      `配置文件（cordis.patch.yml）设为 ${deadlineText(facts.baseline, acp)}，此处设置优先。`,
      `The config file (cordis.patch.yml) asks for ${deadlineText(facts.baseline, acp)}; the value set here wins.`,
    )
  const modeNote = facts.modeBaseline === undefined
    ? undefined
    : acp.label(
      `配置文件（cordis.patch.yml）设为「${modeText(facts.modeBaseline, acp)}」，此处设置优先。`,
      `The config file (cordis.patch.yml) asks for "${modeText(facts.modeBaseline, acp)}"; the value set here wins.`,
    )
  // In `wait` mode there is no deadline at all, so the slider shows the one
  // thing that is true: no deadline.
  const waitMode = deadlines.mode === 'wait'
  return (
    <section className="dwa-section">
      <div className="dwa-section-heading">
        <div>
          <h3 className="dwa-section-title">{acp.label('审批时限', 'Approval deadlines')}</h3>
          <p className="dwa-section-copy">
            {acp.label(
              '权限请求的等待时长与超时处理方式。',
              'How long to wait for a permission request, and what happens when nobody answers.',
            )}
          </p>
        </div>
      </div>
      <div className="dwa-preferences">
        <DeadlineModeBlock acp={acp} mode={deadlines.mode} override={modeNote} />
        <DeadlineSliderBlock
          acp={acp}
          value={waitMode ? undefined : deadlines.permissionTimeoutMs}
          mode={deadlines.mode}
          override={baselineNote}
        />
        {facts.overridden && (
          <div className="dwa-deadline-reset">
            <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.resetApprovalDeadlines()}>
              {acp.label('恢复配置文件的值', 'Use config file value')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * The idle-release window, as the settings page edits it.
 *
 * ONE control, because there is ONE window: how long a chat process may sit
 * idle before it is parked. The slider snaps to the shared ladder
 * ({@link IDLE_RELEASE_MS}), so every rung it offers is a window the host can
 * run.
 *
 * The card reports the deployment baseline as the fact being overridden, and
 * offers a reset ONLY when something is really overridden — the same rule the
 * approval deadline card follows.
 */
function IdleReleaseCard(props: { acp: AcpStore; ui: UiState }) {
  const { acp, ui } = props
  const release = ui.idleRelease
  // Older host half: no card rather than a number this browser invented.
  if (release === undefined) return null
  // The value a RESET returns to: the window `cordis.patch.yml` names, else
  // the built-in default. The same split the approval card keeps — the
  // reset must restore what the deployment asked for, not a constant.
  const baseline = release.defaultIdleTimeoutMs
  // A reset is only honest when something is actually being overridden.
  const overridden = release.idleTimeoutMs !== baseline
  // A window the deployment named that is not on the ladder still runs as
  // configured: the thumb parks on the nearest rung and the readout prints the
  // exact number, so the card never lies about what is in force.
  const index = IDLE_RELEASE_MS.indexOf(release.idleTimeoutMs)
  const exact = index >= 0
  const shown = exact ? release.idleTimeoutMs : nearestIdleRung(release.idleTimeoutMs)
  // The config file's window is worth saying only when it is being
  // outranked — otherwise it IS what runs, and saying "the value set here
  // wins" would name a win nobody claimed.
  const note = release.configuredIdleTimeoutMs === undefined
    || release.configuredIdleTimeoutMs === release.idleTimeoutMs
    ? undefined
    : acp.label(
      `配置文件（cordis.patch.yml）设为 ${idleWindowText(release.configuredIdleTimeoutMs, acp)}，此处设置优先。`,
      `The config file (cordis.patch.yml) asks for ${idleWindowText(release.configuredIdleTimeoutMs, acp)}; the value set here wins.`,
    )
  const resetLabel = release.configuredIdleTimeoutMs === undefined
    ? acp.label('恢复默认值', 'Restore default')
    : acp.label('恢复配置文件的值', 'Use config file value')
  return (
    <section className="dwa-section">
      <div className="dwa-section-heading">
        <div>
          <h3 className="dwa-section-title">{acp.label('空闲释放', 'Idle release')}</h3>
          <p className="dwa-section-copy">
            {acp.label('空闲多久后挂起聊天进程。', 'How long an idle chat process is kept before it is parked.')}
          </p>
        </div>
      </div>
      <div className="dwa-preferences">
        <div className="dwa-preference-block">
          <div className="dwa-preference-label">{acp.label('释放窗口', 'Release window')}</div>
          <div className="dwa-deadline-value">{idleWindowText(release.idleTimeoutMs, acp)}</div>
          <input
            className="dwa-deadline-range"
            type="range"
            min={0}
            max={IDLE_RELEASE_MS.length - 1}
            step={1}
            value={exact ? index : IDLE_RELEASE_MS.indexOf(shown)}
            aria-label={acp.label('释放窗口', 'Release window')}
            onChange={event => {
              const next = IDLE_RELEASE_MS[Number(event.target.value)]
              if (next !== undefined && next !== release.idleTimeoutMs) void acp.setIdleRelease(next)
            }}
          />
          <div className="dwa-deadline-ticks">
            {IDLE_RELEASE_MS.filter((_, i) => i % 2 === 0).map(ms => (
              <span key={ms}>{idleWindowText(ms, acp)}</span>
            ))}
          </div>
          <div className="dwa-preference-copy">
            {acp.label(
              '挂起后会话仍保留，下一条消息自动恢复。',
              'A parked session is kept; the next message resumes it.',
            )}
          </div>
          {note !== undefined && <div className="dwa-deadline-flag">⚠ {note}</div>}
        </div>
        {overridden && (
          <div className="dwa-deadline-reset">
            <button type="button" className="dwa-btn dwa-btn-secondary" onClick={() => void acp.resetIdleRelease()}>
              {resetLabel}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * The rung nearest a window that is not on the ladder — used only to park the
 * thumb; the readout always prints the exact value.
 */
function nearestIdleRung(ms: number): number {
  let best = IDLE_RELEASE_MS[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const rung of IDLE_RELEASE_MS) {
    const distance = Math.abs(rung - ms)
    if (distance < bestDistance) {
      bestDistance = distance
      best = rung
    }
  }
  return best
}

/**
 * `30 分钟` — the readout and the tick label, one formatter.
 *
 * ALWAYS minutes, even at the top of the ladder: a scale that runs "1 分钟"
 * to "50 分钟" and then "1 小时" reads as two different scales.
 */
function idleWindowText(ms: number, acp: AcpStore): string {
  // 0 is the deployment's way of saying "never release", and reading it as
  // "0 分钟" would say the opposite.
  if (ms <= 0) return acp.label('永不释放', 'Never')
  const minutes = Math.round(ms / 60_000)
  return acp.label(`${String(minutes)} 分钟`, `${String(minutes)}m`)
}

type SettingsPage = 'agents' | 'add' | 'approvals' | 'processes' | 'appearance' | 'logs' | 'diagnostics'

/**
 * Local wall-clock `HH:MM:SS` for one runtime-log line. Hand-built on purpose:
 * `toLocaleTimeString` may drop seconds or pick a 12-hour clock depending on
 * the browser locale, which makes the column ragged and ambiguous.
 */
function logClock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

/** The states that carry an update badge next to the version badge. */
function updateBadgeText(update: PluginUpdateState, acp: AcpStore): string | undefined {
  if (update.status === 'available') {
    return acp.label(`可更新 v${update.latest ?? update.current}`, `Update v${update.latest ?? update.current}`)
  }
  if (update.status === 'applying') return acp.label('更新中…', 'Updating…')
  if (update.status === 'applied') {
    const installed = update.installed ?? update.latest ?? update.current
    return acp.label(`已更新 v${installed}`, `Updated v${installed}`)
  }
  if (update.status === 'restart-required') {
    // Only a KNOWN disk version can be named. An interrupted install leaves
    // `installed` unset, and a badge would have to invent a version.
    if (update.installed === undefined) return undefined
    // Neutral: the disk version can be newer OR older than the running one.
    return acp.label(`待重启 v${update.installed}`, `Restart for v${update.installed}`)
  }
  return undefined
}

/**
 * The version badge's update companion. Every badge is a button, `applying`
 * included: the card is where the install's outcome is read, so the running
 * install must be able to open it too. States without anything to act on get
 * no badge at all — the version badge itself still opens the card.
 */
function PluginUpdateBadge(props: { acp: AcpStore; update: PluginUpdateState; open: boolean; onToggle: () => void }) {
  const { acp, update, open, onToggle } = props
  const text = updateBadgeText(update, acp)
  if (text === undefined) return null
  return (
    <button
      type="button"
      className="dwa-badge dwa-badge-info dwa-update-badge"
      aria-expanded={open}
      aria-controls="ntr-plugin-update-card"
      onClick={onToggle}
    >
      {text}
    </button>
  )
}

/**
 * The update card. In-page, no dialog: the settings page already owns the one
 * action (install the exact version the host reported), and a modal on top of
 * a settings section would hide the version it is updating.
 *
 * The copy stays to one line per state (constraint 33); the host's raw error
 * (`message`) is the only long text, and it wraps on its own line so a stack
 * trace or a registry error is readable without stretching the card.
 */
function PluginUpdateCard(props: { acp: AcpStore; update: PluginUpdateState; onClose: () => void }) {
  const { acp, update, onClose } = props
  const applying = update.status === 'applying'
  const latest = update.latest ?? update.current
  const onDisk = update.installed !== undefined && update.installed !== update.current
    ? update.installed
    : undefined
  const published = update.publishedAt !== undefined && !Number.isNaN(new Date(update.publishedAt).getTime())
    ? new Date(update.publishedAt).toLocaleDateString()
    : undefined
  const copy = update.status === 'available'
    ? acp.label('更新会卸载并重装插件，之后可能需要重启 DSH。', 'Updating uninstalls and reinstalls the plugin, and may require restarting DSH.')
    : update.status === 'applied'
      ? acp.label('已应用，刷新页面即可使用新版本。', 'Applied. Reload the page to use the new version.')
      : update.status === 'restart-required'
        ? update.installed !== undefined
          ? acp.label(
            `磁盘已是 v${update.installed}，重启 DSH 后生效（桌面 App 退出重开；命令行重启 dsh web）。`,
            `On disk v${update.installed}. Restart DSH to apply (quit and reopen the app, or restart dsh web).`,
          )
          : acp.label(
            '更新可能已完成，请刷新页面确认当前版本。',
            'The update may already be complete. Refresh the page to confirm the current version.',
          )
        : update.status === 'busy'
          ? acp.label('有进行中的对话，结束后才能更新。', 'Finish the running conversation before updating.')
          : update.status === 'failed'
            ? acp.label('更新失败。', 'Update failed.')
            : update.status === 'current'
              ? acp.label('已是最新版本。', 'Up to date.')
              : update.status === 'source-install'
                ? acp.label(
                  '源码或本地安装，无法通过 registry 更新。',
                  'Source or local install; update it through its own checkout.',
                )
                : update.status === 'managed'
                  ? acp.label('此安装由宿主管理，不能在这里更新。', 'This install is managed by the host and cannot be updated here.')
                  : undefined
  const showMessage = (update.status === 'failed' || update.status === 'busy' || update.status === 'managed')
    && update.message !== undefined
  const apply = async (): Promise<void> => {
    if (update.latest === undefined) return
    try {
      await acp.applyPluginUpdate(update.latest)
    } catch {
      // The store keeps the "disk may have changed" state and writes its own notice.
    }
  }
  return (
    <div
      id="ntr-plugin-update-card"
      className="dwa-card dwa-update-card"
      role="group"
      aria-label={acp.label('插件更新', 'Plugin update')}
    >
      <div className="dwa-update-summary">
        <span>{acp.label(`当前 v${update.current}`, `Current v${update.current}`)}</span>
        {onDisk !== undefined && <span className="dwa-hint">{acp.label(`磁盘 v${onDisk}`, `On disk v${onDisk}`)}</span>}
        {update.latest !== undefined && (
          <>
            <span aria-hidden="true">→</span>
            <span>{acp.label(`最新 v${latest}`, `Latest v${latest}`)}</span>
            {published !== undefined && <span className="dwa-hint">{published}</span>}
          </>
        )}
      </div>
      {copy !== undefined && <p className="dwa-update-copy">{copy}</p>}
      {showMessage && <div className="dwa-update-message">{update.message}</div>}
      <div className="dwa-row-actions dwa-update-actions">
        {update.status === 'available' && (
          <button type="button" className="dwa-btn dwa-btn-primary" onClick={() => { void apply() }}>
            {acp.label('更新', 'Update')}
          </button>
        )}
        {applying && (
          <button type="button" className="dwa-btn dwa-btn-primary" disabled>
            {acp.label('正在更新…', 'Updating…')}
          </button>
        )}
        {update.status !== 'applying' && (
          <button type="button" className="dwa-btn" onClick={onClose}>{acp.label('关闭', 'Close')}</button>
        )}
        <button type="button" className="dwa-btn dwa-btn-quiet" disabled={applying} onClick={() => void acp.checkPluginUpdate(true)}>
          {acp.label('重新检查', 'Check again')}
        </button>
      </div>
    </div>
  )
}

/**
 * The card is drawn for every state a host can report about this install,
 * except the two where there is no install to talk about at all.
 */
function updateCardVisible(update: PluginUpdateState | undefined, open: boolean): boolean {
  if (update === undefined || !open) return false
  return update.status !== 'unsupported' && update.status !== 'not-installed'
}

export function AcpSettingsSection(props: WithStore) {
  const acp = props.acp
  ensureStyle()
  const ui = useUi(acp)
  const ledger = permissionLedgerCard(ui)
  const [page, setPage] = useState<SettingsPage>('agents')
  const [addOpen, setAddOpen] = useState(false)
  const [addTarget, setAddTarget] = useState<DetectedAgentInfo | undefined>(undefined)
  const [updateOpen, setUpdateOpen] = useState(false)
  // The store throttles this to one registry read per ten minutes, so every
  // remount (both settings entries mount this section) is cheap.
  useEffect(() => {
    void acp.checkPluginUpdate()
  }, [acp])
  // Opening the log is the read receipt. The store does not mutate at zero,
  // so this cannot loop.
  useEffect(() => {
    if (page === 'logs' && ui.logUnread > 0) acp.markLogsRead()
  }, [acp, page, ui.logUnread])
  const { configured, available } = partitionAgents(ui.detectedAgents, ui.agents)
  const selected = addTarget ?? available[0] ?? NEW_AGENT_SEED
  const openAdd = (): void => {
    setAddOpen(true)
    setPage('add')
  }
  const presetProblem = ui.preset !== undefined && (!ui.preset.installed || ui.preset.problem !== undefined)
  const update = ui.pluginUpdate
  // A source install cannot be replaced by this browser; the version badge
  // says so on hover. Neutral wording: a checkout may be git or not.
  const versionTitle = update?.status === 'source-install'
    ? acp.label('源码或本地安装，无法通过 registry 更新。', 'Source or local install; update it through its own checkout.')
    : undefined
  // The running version is the update entry: every state with a real install
  // report can open the card, including "up to date" (which offers a re-check).
  const versionOpensUpdate = update !== undefined
    && update.status !== 'unsupported'
    && update.status !== 'not-installed'

  return (
    <div className="dwa-root">
      <header className="dwa-page-header">
        <div className="dwa-page-heading">
          <h2 className="dwa-page-title" aria-label={acp.label('NTR 设置', 'NTR settings')}>
            {acp.label('NTR 设置', 'NTR settings')}
            {ui.pluginVersion !== undefined && (
              versionOpensUpdate
                ? (
                  <button
                    type="button"
                    className="dwa-badge dwa-version dwa-version-btn"
                    title={versionTitle}
                    aria-expanded={updateOpen}
                    aria-controls="ntr-plugin-update-card"
                    onClick={() => setUpdateOpen(open => !open)}
                  >
                    {`v${ui.pluginVersion}`}
                  </button>
                )
                : <span className="dwa-badge dwa-version" title={versionTitle}>{`v${ui.pluginVersion}`}</span>
            )}
            {update !== undefined && (
              <PluginUpdateBadge
                acp={acp}
                update={update}
                open={updateOpen}
                onToggle={() => setUpdateOpen(open => !open)}
              />
            )}
          </h2>
          <p className="dwa-page-description">
            {acp.label('连接智能体，设置你的对话偏好。', 'Connect agents and set your conversation preferences.')}
          </p>
        </div>
        {page === 'agents' && configured.length > 0 && (
          <button type="button" className="dwa-btn dwa-btn-primary" onClick={openAdd}>
            {acp.label('添加智能体', 'Add agent')}
          </button>
        )}
      </header>

      {update !== undefined && updateCardVisible(update, updateOpen) && (
        <PluginUpdateCard acp={acp} update={update} onClose={() => setUpdateOpen(false)} />
      )}

      {/* The cross-session mirror: the conversation dock answers the asks
          belonging to the open conversation; this card answers the rest. */}
      {ledger.visible && (
        <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {acp.label('待处理权限请求', 'Pending Permission Requests')}
          </div>
          <div className="dwa-hint" style={{ marginBottom: 8 }}>
            {acp.label(
              '对话打开时在那边的卡片上回答；这里兜底显示其他会话的询问。',
              'Answer in the conversation card while that conversation is open; this list covers the asks whose conversation is not.',
            )}
          </div>
          {ui.permissions.map(permission => (
            <div key={permission.requestId} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 160 }}>
                <span style={{ fontWeight: 600 }}>{permission.toolName}</span>
                {permission.reason !== undefined && (
                  <span style={{ color: 'var(--ntr-muted)' }}> · {permission.reason}</span>
                )}
              </span>
              {permission.options.map(option => (
                <button
                  key={option.optionId}
                  type="button"
                  className="dwa-btn"
                  onClick={() => { void acp.respondPermission(permission.requestId, option.optionId).catch(() => undefined) }}
                >
                  {option.name}
                </button>
              ))}
              <button type="button" className="dwa-btn dwa-btn-quiet" onClick={() => { void acp.respondPermission(permission.requestId).catch(() => undefined) }}>
                {acp.label('取消', 'Cancel')}
              </button>
            </div>
          ))}
        </div>
      )}

      {ui.notice !== undefined && (
        <div className="dwa-card dwa-card-warn" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{ui.notice}</span>
          <button type="button" className="dwa-btn dwa-btn-quiet" aria-label={acp.label('关闭通知', 'Dismiss notice')} onClick={() => acp.clearNotice()}>✕</button>
        </div>
      )}

      {presetProblem && (
        <div className="dwa-card dwa-card-warn dwa-notice" role="status">
          <span>{acp.label('NTR 模式需要检查，当前可能无法开始对话。', 'NTR mode needs attention; new conversations may be unavailable.')}</span>
          <button type="button" className="dwa-btn" onClick={() => setPage('diagnostics')}>{acp.label('查看诊断', 'View diagnostics')}</button>
        </div>
      )}
      <nav className="dwa-tabs" aria-label={acp.label('NTR 设置分类', 'NTR settings categories')}>
        <button type="button" aria-pressed={page === 'agents'} onClick={() => setPage('agents')}>{acp.label('智能体', 'Agents')}</button>
        {ui.approvalDeadlines !== undefined && <button type="button" aria-pressed={page === 'approvals'} onClick={() => setPage('approvals')}>{acp.label('审批时限', 'Approval deadlines')}</button>}
        {ui.idleRelease !== undefined && <button type="button" aria-pressed={page === 'processes'} onClick={() => setPage('processes')}>{acp.label('进程管理', 'Processes')}</button>}
        <button type="button" aria-pressed={page === 'appearance'} onClick={() => setPage('appearance')}>{acp.label('对话外观', 'Appearance')}</button>
        <button type="button" aria-pressed={page === 'logs'} onClick={() => setPage('logs')}>
          {acp.label('日志', 'Logs')}
          {ui.logUnread > 0 && <span className="dwa-log-dot" aria-hidden="true" />}
        </button>
      </nav>
      {page === 'diagnostics' && (
        <section className="dwa-section">
          <h3 className="dwa-section-title">{acp.label('连接诊断', 'Connection diagnostics')}</h3>
          <div className="dwa-preference-row"><span>{acp.label('宿主事件流', 'Host event stream')}</span><span className="dwa-hint">{streamText(ui.stream, acp)}</span></div>
          <div className="dwa-row-actions">
            <button type="button" className="dwa-btn" onClick={() => { void acp.resync(); void acp.detectAgents() }} disabled={ui.detecting}>
              {ui.detecting ? acp.label('检测中...', 'Detecting...') : acp.label('重新检测与刷新', 'Re-detect & Refresh')}
            </button>
            {ui.detectSummary !== undefined && <span className="dwa-hint" role="status">{ui.detectSummary}</span>}
          </div>
        </section>
      )}
      {page === 'diagnostics' && ui.preset !== undefined && (
        <div className="dwa-card dwa-mode-banner">
          <div className="dwa-mode-title">
            {acp.label('NTR 模式', 'NTR mode')}
            <span className="dwa-badge">{ui.preset.id}</span>
          </div>
          <span className={`dwa-badge ${ui.preset.installed ? 'dwa-badge-success' : 'dwa-badge-warn'}`}>
            {ui.preset.installed ? acp.label('已就绪', 'Ready') : acp.label('需检查', 'Needs attention')}
          </span>
          <div className="dwa-mode-copy">
            {ui.preset.installed
              ? acp.label('已加入宿主模式列表，新建会话时选择「NTR 模式」即可使用。', 'Added to the harness roster. Pick “NTR mode” when creating a session.')
              : acp.label('宿主模式列表中没有可用的「NTR 模式」，请检查预设声明。', 'The harness roster has no usable “NTR mode”. Check the preset declaration.')}
            <code className="dwa-mode-source dwa-mono">{ui.preset.source}</code>
          </div>
          {ui.preset.problem !== undefined && (
            <div className="dwa-hint" style={{ gridColumn: '1 / -1', color: 'var(--ntr-warn)' }}>
              {acp.label(`宿主报告：${ui.preset.problem}`, `Harness reported: ${ui.preset.problem}`)}
            </div>
          )}
        </div>
      )}

      {/* Keep editors mounted so navigation preserves unsaved values. */}
      <section className="dwa-section" hidden={page !== 'agents'} aria-label={acp.label('已接入的智能体', 'Connected agents')}>
        <div className="dwa-section-heading">
          <div>
            <h3 className="dwa-section-title">
              {acp.label('已接入的智能体', 'Connected agents')}
              {ui.agentsLoaded && <span className="dwa-badge">{configured.length}</span>}
            </h3>
          </div>
          {configured.length > 0 && <span className="dwa-hint">{acp.label('默认项用于新的 NTR 会话', 'The default serves new NTR conversations')}</span>}
        </div>

        {!ui.agentsLoaded && <div className="dwa-empty" role="status">{acp.label('正在读取智能体…', 'Loading agents…')}</div>}
        {ui.agentsLoaded && configured.length === 0 && (
          <div className="dwa-empty">
            <h3>{acp.label('接入第一个智能体', 'Connect your first agent')}</h3>
            <p className="dwa-section-copy">{acp.label('选择已有预设，或填写自己的 ACP 启动命令。', 'Choose a preset or enter your own ACP launch command.')}</p>
            <button type="button" className="dwa-btn dwa-btn-primary" onClick={openAdd}>{acp.label('添加智能体', 'Add agent')}</button>
          </div>
        )}

        <div className="dwa-agent-list">
          {configured.map(({ info, synthesized }) => {
            const activeAgent = ui.agents.find(a => a.id === info.id)
            return (
              <AgentRow
                key={info.id}
                detected={info}
                activeAgent={activeAgent}
                acp={acp}
                isDefault={ui.defaultAgent === info.id}
                synthesized={synthesized}
                active={page === 'agents'}
              />
            )
          })}
        </div>
      </section>

      <section className="dwa-section" hidden={page !== 'add'} aria-label={acp.label('添加智能体', 'Add agent')}>
        <button type="button" className="dwa-btn dwa-btn-quiet dwa-back" onClick={() => setPage('agents')}>{acp.label('返回智能体列表', 'Back to agents')}</button>
        <div className="dwa-add-panel">
          <div className="dwa-section-heading">
            <div>
              <h3 className="dwa-section-title">{acp.label('添加智能体', 'Add agent')}</h3>
              <p className="dwa-section-copy">{acp.label('从预设快速启用，或创建自定义连接。', 'Enable a preset or create a custom connection.')}</p>
            </div>
          </div>
          {addOpen && (
            <div className="dwa-add-content">
              <div className="dwa-chip-list">
              {available.map(info => (
                <button
                  key={info.id}
                  type="button"
                  className={`dwa-chip${selected.id === info.id ? ' dwa-chip-active' : ''}`}
                  onClick={() => setAddTarget(info)}
                  title={info.description}
                >
                  {info.name}
                </button>
              ))}
              <button
                type="button"
                className={`dwa-chip${selected.id === '' ? ' dwa-chip-active' : ''}`}
                onClick={() => setAddTarget(NEW_AGENT_SEED)}
              >
                {acp.label('自定义', 'Custom')}
              </button>
            </div>
            {available.length === 0 && selected.id === '' && (
              <div className="dwa-hint" style={{ marginBottom: 8 }}>
                {acp.label('没有更多可启用的预设 Agent。', 'No more detected presets to enable.')}
              </div>
            )}
            <AgentRow
              key={selected.id}
              detected={selected}
              acp={acp}
              isDefault={false}
              synthesized={false}
              newCustom={selected.id === ''}
              active={page === 'add'}
              onCreated={() => {
                setAddTarget(undefined)
                setAddOpen(false)
                setPage('agents')
              }}
            />
            </div>
          )}
        </div>
      </section>

      <div hidden={page !== 'approvals'}><ApprovalDeadlinesCard acp={acp} ui={ui} /></div>
      <div hidden={page !== 'processes'}><IdleReleaseCard acp={acp} ui={ui} /></div>

      <section className="dwa-section" hidden={page !== 'appearance'} aria-label={acp.label('对话外观', 'Appearance')}>
        <div className="dwa-section-heading">
          <div>
            <h3 className="dwa-section-title">{acp.label('对话外观', 'Conversation appearance')}</h3>
            <p className="dwa-section-copy">{acp.label('设置对话中 NTR 挂牌的进程存活提示。', 'Choose how the NTR tag indicates a running agent process.')}</p>
          </div>
        </div>
        <div className="dwa-preferences">
          <div className="dwa-preference-row">
            <div>
              <div className="dwa-preference-label">{acp.label('挂牌光晕', 'Tag halo')}</div>
              <div className="dwa-preference-copy">{acp.label('呼吸为脉动光，常亮为恒定光。', 'Breathe pulses gently; steady keeps a constant glow.')}</div>
            </div>
            <div className="dwa-seg">
              {(['breath', 'steady'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  className={ui.tagHalo.mode === mode ? 'is-on' : ''}
                  onClick={() => void acp.setTagHalo({ ...ui.tagHalo, mode })}
                >
                  {mode === 'breath' ? acp.label('呼吸', 'Breathe') : acp.label('常亮', 'Steady')}
                </button>
              ))}
            </div>
          </div>
          {ui.tagHalo.mode === 'breath' && (
            <div className="dwa-preference-row">
              <div>
                <div className="dwa-preference-label">{acp.label('呼吸频率', 'Breathing speed')}</div>
                <div className="dwa-preference-copy">{acp.label('控制光晕的脉动速度。', 'Controls how quickly the halo pulses.')}</div>
              </div>
              <div className="dwa-seg">
                {(['slow', 'normal', 'fast'] as const).map(speed => (
                  <button
                    key={speed}
                    type="button"
                    className={ui.tagHalo.speed === speed ? 'is-on' : ''}
                    onClick={() => void acp.setTagHalo({ ...ui.tagHalo, speed })}
                  >
                    {speed === 'slow' ? acp.label('慢速', 'Slow') : speed === 'normal' ? acp.label('正常', 'Normal') : acp.label('快速', 'Fast')}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
      {/* Conditional on purpose: this list can hold 200 rows, and keeping it
          mounted through a `hidden` page would re-render every line on each
          `session/update`. It carries no local state, so remounting is free. */}
      {page === 'logs' && (
        <section className="dwa-section" aria-label={acp.label('运行日志', 'Runtime log')}>
          <div className="dwa-section-heading">
            <div>
              <h3 className="dwa-section-title">{acp.label('运行日志', 'Runtime log')}</h3>
              <p className="dwa-section-copy">
                {acp.label(
                  `agent 运行消息，最多 ${String(LOG_MAX_ENTRIES)} 条。`,
                  `Agent runtime messages, up to ${String(LOG_MAX_ENTRIES)}.`,
                )}
              </p>
            </div>
            {ui.logs.length > 0 && (
              <button type="button" className="dwa-btn dwa-btn-quiet" onClick={() => acp.clearLogs()}>
                {acp.label('清空', 'Clear')}
              </button>
            )}
          </div>
          {ui.logs.length === 0
            ? <div className="dwa-empty" role="status">{acp.label('暂无运行日志。', 'No runtime messages yet.')}</div>
            : (
              <ul className="dwa-log-list">
                {[...ui.logs].reverse().map(entry => (
                  <li key={entry.id} className={entry.level === 'error' ? 'dwa-log-row is-error' : 'dwa-log-row'}>
                    <span className="dwa-log-time dwa-mono">{logClock(entry.at)}</span>
                    <span className={`dwa-badge dwa-log-level ${entry.level === 'error' ? 'is-error' : 'is-info'}`}>
                      {entry.level === 'error' ? acp.label('错误', 'Error') : acp.label('信息', 'Info')}
                    </span>
                    {entry.agentId !== undefined && <span className="dwa-badge">{entry.agentId}</span>}
                    <span className="dwa-log-text">{entry.text}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}
      <footer className="dwa-health">
        <div className="dwa-health-status">
          <span className="dwa-dot" style={{ background: ui.stream === 'live' ? 'var(--ntr-success)' : ui.stream === 'down' ? 'var(--ntr-danger)' : 'var(--ntr-muted)' }} />
          <span>{streamText(ui.stream, acp)}</span>
          {ui.preset !== undefined && <span>{ui.preset.installed && !presetProblem ? acp.label('NTR 模式已就绪', 'NTR mode ready') : acp.label('NTR 模式需检查', 'NTR mode needs attention')}</span>}
        </div>
        {page !== 'diagnostics' && <button type="button" className="dwa-btn dwa-btn-quiet" onClick={() => setPage('diagnostics')}>{acp.label('查看诊断', 'View diagnostics')}</button>}
      </footer>
    </div>
  )
}

/** One row per agent: compact when collapsed, the full form when expanded. */
function AgentRow({
  detected,
  activeAgent,
  acp,
  isDefault,
  synthesized,
  active,
  newCustom = false,
  onCreated,
}: {
  detected: DetectedAgentInfo
  activeAgent?: AgentView
  acp: AcpStore
  isDefault: boolean
  synthesized: boolean
  active: boolean
  /** From-scratch creation: the id is editable and no preset defaults exist. */
  newCustom?: boolean
  /** Fired after a creation-card save succeeds (the list re-derives its selection). */
  onCreated?: () => void
}) {
  const ui = useUi(acp)
  const configured = activeAgent !== undefined || detected.currentConfig !== undefined
  // A configured agent starts collapsed; a creation card opens straight away
  // (nothing to summarise yet).
  const [expanded, setExpanded] = useState(!configured)
  const [detailPage, setDetailPage] = useState<'models' | 'connection' | 'advanced'>(configured ? 'models' : 'connection')
  const [form, setForm] = useState<AgentForm>(() => initialForm(detected, activeAgent))
  const [saving, setSaving] = useState(false)
  const [savedSuccess, setSavedSuccess] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const patch = (next: Partial<AgentForm>): void => setForm(prev => ({ ...prev, ...next }))

  const serverExposureKey = exposureKey(detected.currentConfig?.exposedModels)
  useEffect(() => {
    const server = detected.currentConfig?.exposedModels
    setForm(prev => ({ ...prev, exposed: server === undefined ? undefined : [...server] }))
    // Re-sync the editor only when the persisted filter actually changes, so
    // background resyncs never clobber in-progress checkbox edits.
  }, [serverExposureKey])

  const serverAutoDiscover = detected.currentConfig?.autoDiscoverModels !== false
  useEffect(() => {
    // The switch saves itself through the lightweight RPC, so the host is the
    // truth; this keeps the form (and therefore a later full save) in step.
    setForm(prev => ({ ...prev, autoDiscoverModels: serverAutoDiscover }))
  }, [serverAutoDiscover])

  const trimmedId = form.agentId.trim()
  const idValid = !newCustom || AGENT_ID_PATTERN.test(trimmedId)
  const idTaken = newCustom && trimmedId !== '' && ui.agents.some(a => a.id === trimmedId)
  const cwdInvalid = form.cwd.trim() !== '' && !isAbsolutePathLike(form.cwd.trim())
  const rootValues = form.roots.map(root => root.trim()).filter(root => root !== '')
  const rootsInvalid = form.rootsOpen && (rootValues.length === 0 || rootValues.some(root => !isAbsolutePathLike(root)))
  const idleInvalid = !idleValid(form.idleStr)
  const mcpInvalid = !mcpTextValid(form.mcpText)
  const formIncomplete = splitCommandLine(form.commandLine).command === '' || !idValid || idTaken || cwdInvalid || rootsInvalid || idleInvalid || mcpInvalid

  const payload = buildPayload(form, detected, newCustom)
  const current = persistedDef(detected, activeAgent)
  const clearingIdleOverride = payload.idleTimeoutMs === undefined && detected.currentConfig?.idleTimeoutMs !== undefined
  const dirty = current !== undefined && (!payloadEquals(payload, current) || clearingIdleOverride)
  // A save stops the child and kills every live session (see BridgeManager.saveAgent).
  const showSaveWarning = dirty && activeAgent !== undefined && activeAgent.state !== 'stopped'

  const handleUseDefault = (): void => patch({ commandLine: formatCommandLine(detected.defaultCommand, detected.defaultArgs) })

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSavedSuccess(false)
    try {
      await acp.saveAgent(payload)
      // A save from the creation card resets the list's selection: the agent
      // now lives in the configured list, and keeping the same card mounted
      // would render it twice. Configured rows pass no `onCreated`, so this is
      // a no-op for them.
      onCreated?.()
      if (newCustom) return
      setSavedSuccess(true)
      setTimeout(() => setSavedSuccess(false), 2000)
    } catch {
      // Error handled by store
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(undefined)
    try {
      const result = await acp.testAgent(payload)
      setTestResult(result.ok
        ? {
          ok: true,
          text: acp.label('连接成功', 'Connected') + (result.agentInfo?.name !== undefined ? ` · ${result.agentInfo.name}` : '')
            + (result.agentInfo?.version !== undefined ? ` v${result.agentInfo.version}` : '')
            + ` · ${String(result.durationMs)}ms`,
        }
        : { ok: false, text: result.error ?? acp.label('未知错误', 'Unknown error') })
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  const state = activeAgent !== undefined ? stateVisual(activeAgent.state, acp) : undefined
  const displayName = newCustom
    ? acp.label('新建自定义 Agent', 'New Custom Agent')
    : (activeAgent?.title ?? detected.currentConfig?.title ?? detected.name)
  const stderr = activeAgent?.state === 'error' ? (activeAgent.stderrTail ?? []) : []
  const errorSummary = stderr.length > 0 ? stderr[stderr.length - 1] : undefined
  const selectedModelCount = form.exposed?.length ?? 0
  const isPreset = PRESET_IDS.has(detected.id)
  // An error row opens itself so the stderr tail is never behind a click.
  const open = expanded || (activeAgent?.state === 'error' && configured)

  return (
    <div className={`dwa-agent-card${open ? ' is-open' : ''}`}>
      <div className="dwa-agent-row">
        <span className="dwa-agent-avatar" aria-hidden>{displayName.slice(0, 2).toUpperCase()}</span>
        <div className="dwa-agent-summary">
          <div className="dwa-agent-titleline">
            <span className="dwa-agent-name" title={detected.executablePath ?? detected.description}>{displayName}</span>
            {isDefault && <span className="dwa-badge dwa-badge-info">{acp.label('默认', 'Default')}</span>}
            {!isPreset && !newCustom && <span className="dwa-badge">{acp.label('自定义', 'Custom')}</span>}
          </div>
          <div className="dwa-agent-meta">
            {state !== undefined && (
              <span title={state.title ?? activeAgent?.state} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="dwa-dot" style={{ background: state.color }} />
                {state.text}
              </span>
            )}
            {configured && (
              <>
                {state !== undefined && <span className="dwa-agent-meta-separator">·</span>}
                <span>{acp.label(`${String(selectedModelCount)} 个已选模型`, `${String(selectedModelCount)} selected models`)}</span>
              </>
            )}
            {!synthesized && !newCustom && !detected.detected && (
              <span style={{ color: 'var(--ntr-warn)' }} title={detected.description}>
                · {acp.label('未在 PATH 中检测到', 'Not in PATH')}
              </span>
            )}
          </div>
          {errorSummary !== undefined && (
            <div className="dwa-error dwa-mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>{errorSummary}</div>
          )}
        </div>
        <div className="dwa-row-actions">
          {configured && (
            <button type="button" className="dwa-btn dwa-btn-quiet" aria-expanded={open} aria-label={acp.label(`${open ? '收起' : '管理'} ${displayName}`, `${open ? 'Collapse' : 'Manage'} ${displayName}`)} onClick={() => setExpanded(value => !value)}>
              {open ? acp.label('收起', 'Collapse') : acp.label('管理', 'Manage')}
            </button>
          )}
          {activeAgent?.state === 'error' && (
            <button className="dwa-btn" disabled={testing} onClick={() => void handleTest()}>
              {testing ? acp.label('测试中...', 'Testing...') : acp.label('测试', 'Test')}
            </button>
          )}
          {configured && (
            <RowMenu
              acp={acp}
              canStop={activeAgent !== undefined && activeAgent.state !== 'stopped'}
              onStop={() => void acp.stopAgent(detected.id)}
              // The store already surfaced the failure as a notice; swallowing it
              // here only prevents an unhandled rejection.
              onRemove={async () => { await acp.deleteAgent(detected.id).catch(() => { /* notice shown by the store */ }) }}
            />
          )}
        </div>
      </div>

      {/* display-toggled (not conditionally mounted) so an in-progress edit
          survives collapsing the row. */}
      <div className="dwa-agent-body" style={open ? undefined : { display: 'none' }}>
        {stderr.length > 0 && <pre className="dwa-stderr">{stderr.join('\n')}</pre>}
        <nav className="dwa-tabs dwa-detail-tabs" aria-label={acp.label(`${displayName} 配置`, `${displayName} settings`)}>
          {configured && <button type="button" aria-pressed={detailPage === 'models'} onClick={() => setDetailPage('models')}>{acp.label('模型', 'Models')}</button>}
          <button type="button" aria-pressed={detailPage === 'connection'} onClick={() => setDetailPage('connection')}>{acp.label('连接', 'Connection')}</button>
          <button type="button" aria-pressed={detailPage === 'advanced'} onClick={() => setDetailPage('advanced')}>{acp.label('高级', 'Advanced')}</button>
        </nav>
        {configured && (
          <section className="dwa-subsection" hidden={detailPage !== 'models'}>
            <ModelCatalogBlock
              agentId={detected.id}
              detected={detected}
              acp={acp}
              active={active && open && detailPage === 'models'}
              exposed={form.exposed}
              onExposedChange={exposed => patch({ exposed })}
              autoDiscover={form.autoDiscoverModels}
              onAutoDiscoverChange={autoDiscoverModels => patch({ autoDiscoverModels })}
              isDefault={isDefault}
            />
          </section>
        )}
        <section className="dwa-subsection" hidden={detailPage === 'models'}>
          <AgentDetails
            acp={acp}
            advancedOpen={detailPage === 'advanced'}
            dirty={dirty}
            detected={detected}
            form={form}
            patch={patch}
            isConfigured={configured}
            newCustom={newCustom}
            formIncomplete={formIncomplete}
            idValid={idValid}
            idTaken={idTaken}
            cwdInvalid={cwdInvalid}
            rootsInvalid={rootsInvalid}
            idleInvalid={idleInvalid}
            mcpInvalid={mcpInvalid}
            saving={saving}
            savedSuccess={savedSuccess}
            testing={testing}
            testResult={testResult}
            showSaveWarning={showSaveWarning}
            onUseDefault={handleUseDefault}
            onSave={() => void handleSave()}
            onTest={() => void handleTest()}
          />
        </section>
      </div>
    </div>
  )
}

/** Everything the connection form edits, in one object (kept in the row). */
interface AgentForm {
  agentId: string
  title: string
  /**
   * ONE command line — program first, arguments after, quoting to keep a path
   * with spaces in one piece (`splitCommandLine`). The old split into
   * `command` + `argsStr` invited the single most common misconfiguration
   * there is: pasting `codebuddy --acp` into the program box, which the host
   * then looked for as a file literally named `codebuddy --acp`.
   */
  commandLine: string
  npmPackage: string
  cwd: string
  /** Advanced: edit every allowed root, not just the single workspace dir. */
  rootsOpen: boolean
  roots: string[]
  envRows: Array<{ key: string; value: string }>
  exposed?: string[]
  /** Auto-append models the agent newly publishes to {@link exposed}. */
  autoDiscoverModels: boolean
  /** Raw text of the idle-release window in ms ('' = host default, '0' = never). */
  idleStr: string
  /**
   * Raw JSON text of the agent's MCP server list (the plugin's normalized
   * shape — every entry carries a `transport`). '' = no extra MCP servers.
   *
   * Kept as TEXT so a half-typed value survives editing instead of being
   * silently reshaped; it is parsed on the way out.
   */
  mcpText: string
}

/**
 * Hand copy of `DEFAULT_TUNING.probeIdleTimeoutMs` (src/bridge.ts). A process
 * that has never hosted a session — the model probe / post-save probe — lives
 * by THIS window whatever the agent's own field says, so the placeholder has to
 * name both windows. Keep the two in sync.
 */
const DEFAULT_PROBE_RELEASE_MS = 300_000

export function initialForm(detected: DetectedAgentInfo, activeAgent: AgentView | undefined): AgentForm {
  const config = detected.currentConfig
  const roots = [...(activeAgent?.allowedCwdRoots ?? config?.allowedCwdRoots ?? [])]
  return {
    agentId: detected.id,
    title: activeAgent?.title ?? config?.title ?? detected.name,
    commandLine: formatCommandLine(
      activeAgent?.command ?? config?.command ?? detected.defaultCommand,
      activeAgent?.args ?? config?.args ?? detected.defaultArgs,
    ),
    npmPackage: config?.npmPackage ?? '',
    cwd: activeAgent?.cwd ?? config?.cwd ?? '',
    // An agent already carrying more than one root opens in advanced mode:
    // single-root mode narrows the allow-list to `cwd` on save, which must
    // never happen as a side effect of merely opening the form.
    rootsOpen: roots.length > 1,
    roots,
    envRows: Object.entries(config?.env ?? {}).map(([key, value]) => ({ key, value })),
    exposed: config?.exposedModels === undefined ? undefined : [...config.exposedModels],
    autoDiscoverModels: config?.autoDiscoverModels !== false,
    // The agent's OWN override only. The host's resolved value is NOT
    // written back here: it would freeze the global window into this
    // agent's definition, and the global slider would then never reach it.
    // An empty field means "follow the global window".
    idleStr: idleText(config?.idleTimeoutMs),
    // The MCP list comes back from the host in its NORMALIZED shape (defaults
    // filled in), so re-serializing it reproduces exactly what is stored —
    // that is what keeps the card from being permanently dirty.
    mcpText: config?.mcpServers === undefined ? '' : JSON.stringify(config.mcpServers, null, 2),
  }
}

function idleText(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/** `MM-DD HH:mm`, local time — compact enough for the catalog's status line. */
function formatStamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Assemble the save/test payload.
 *
 * Workspace rules (P0-1): a non-empty single-root `cwd` also pins
 * `allowedCwdRoots` to exactly that path — an explicit narrowing, so saving
 * from the panel can never silently widen the sandbox. An empty `cwd` sends
 * neither field and the host falls back to `~/.dsh/dsh-ntr/workspaces`. Advanced
 * mode sends the edited roots as-is (deduplicated).
 */
/** `''` = host default, `0` = never release, otherwise a sane millisecond window. */
function idleValid(raw: string): boolean {
  const text = raw.trim()
  if (text === '') return true
  if (!/^\d+$/.test(text)) return false
  const value = Number(text)
  return value === 0 || (value >= 1_000 && value <= 86_400_000)
}

export function buildPayload(form: AgentForm, detected: DetectedAgentInfo, newCustom: boolean): AgentSavePayload {
  const env: Record<string, string> = {}
  for (const row of form.envRows) {
    const key = row.key.trim()
    if (key === '') continue
    env[key] = row.value
  }
  const cwd = form.cwd.trim()
  const idleRaw = form.idleStr.trim()
  // The field is a command line; the host validates it the same way, so what
  // the preview under the input shows is what will actually be spawned.
  const parsed = splitCommandLine(form.commandLine)
  // An unparseable MCP text yields `undefined` here and `mcpInvalid` in the
  // form, which disables saving — so this never throws inside a render.
  const mcpServers = parseMcpServers(form.mcpText)
  const payload: AgentSavePayload = {
    id: newCustom ? form.agentId.trim() : detected.id,
    ...(form.title.trim() === '' ? {} : { title: form.title.trim() }),
    command: parsed.command,
    args: parsed.args,
    ...(form.npmPackage.trim() === '' ? {} : { npmPackage: form.npmPackage.trim() }),
    env,
    ...(form.exposed === undefined ? {} : { exposedModels: form.exposed }),
    // Auto-discovery is ON by default: only an unchecked switch records the
    // opt-out, otherwise a full save would silently re-enable it.
    ...(form.autoDiscoverModels ? {} : { autoDiscoverModels: false }),
    // `''` sends nothing: the host then applies its own default.
    ...(idleRaw === '' || !idleValid(idleRaw) ? {} : { idleTimeoutMs: Number(idleRaw) }),
    // The MCP list is OPTIONAL: absent = the agent connects only to the
    // servers it configures for itself.
    ...(mcpServers === undefined ? {} : { mcpServers }),
  }
  if (form.rootsOpen) {
    if (cwd !== '') payload.cwd = cwd
    const roots = [...new Set(form.roots.map(root => root.trim()).filter(root => root !== ''))]
    if (roots.length > 0) payload.allowedCwdRoots = roots
    return payload
  }
  if (cwd !== '') {
    payload.cwd = cwd
    payload.allowedCwdRoots = [cwd]
  }
  return payload
}

/** The expanded body: connection form, workspace allow-list, env, actions. */
function AgentDetails({
  acp,
  advancedOpen,
  dirty,
  detected,
  form,
  patch,
  isConfigured,
  newCustom,
  formIncomplete,
  idValid,
  idTaken,
  cwdInvalid,
  rootsInvalid,
  idleInvalid,
  mcpInvalid,
  saving,
  savedSuccess,
  testing,
  testResult,
  showSaveWarning,
  onUseDefault,
  onSave,
  onTest,
}: {
  acp: AcpStore
  advancedOpen: boolean
  dirty: boolean
  detected: DetectedAgentInfo
  form: AgentForm
  patch: (next: Partial<AgentForm>) => void
  isConfigured: boolean
  newCustom: boolean
  formIncomplete: boolean
  idValid: boolean
  idTaken: boolean
  cwdInvalid: boolean
  rootsInvalid: boolean
  idleInvalid: boolean
  mcpInvalid: boolean
  saving: boolean
  savedSuccess: boolean
  testing: boolean
  testResult?: { ok: boolean; text: string }
  showSaveWarning: boolean
  onUseDefault: () => void
  onSave: () => void
  onTest: () => void
}) {
  // The same parse the host will run (`validateAgentDef` → `splitCommandLine`).
  // Showing it is what turns "the first box swallowed my arguments" into a
  // visible, fixable state instead of a spawn error.
  const parsedCommand = splitCommandLine(form.commandLine)
  const commandPreview = parsedCommand.command === ''
    ? acp.label('填整条命令，例如：codebuddy --acp', 'Type the whole command, e.g. codebuddy --acp')
    : `${acp.label('程序', 'Program')}: ${parsedCommand.command}`
      + (parsedCommand.args.length === 0 ? '' : `　${acp.label('参数', 'Arguments')}: ${parsedCommand.args.join(' ')}`)
  return (
    <div>
      <div hidden={advancedOpen}>
      {newCustom && (
        <div className="dwa-form-row">
          <div className="dwa-form-col">
            <label className="dwa-form-label">{acp.label('Agent ID（唯一标识，创建后不可改）', 'Agent ID (unique, immutable after creation)')}</label>
            <input
              className="dwa-input dwa-input-mono"
              aria-label={acp.label('Agent ID', 'Agent ID')}
              value={form.agentId}
              onChange={e => patch({ agentId: e.target.value })}
              placeholder="e.g. my-agent"
            />
            <span className={idValid && !idTaken ? 'dwa-hint' : 'dwa-error'}>
              {idTaken
                ? acp.label('该 ID 已被现有 Agent 占用。', 'This id is already taken by a configured agent.')
                : idValid
                  ? acp.label('小写字母或数字开头，可用 a-z 0-9 . _ -，最长 64 字符。', 'Starts with a lowercase letter or digit; a-z 0-9 . _ - allowed; max 64 chars.')
                  : acp.label('ID 格式不合法：小写字母或数字开头，可用 a-z 0-9 . _ -。', 'Invalid id: start with a lowercase letter or digit; only a-z 0-9 . _ - allowed.')}
            </span>
          </div>
        </div>
      )}

      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('显示名', 'Display Name')}</label>
          <input
            className="dwa-input"
            aria-label={acp.label('显示名', 'Display Name')}
            value={form.title}
            onChange={e => patch({ title: e.target.value })}
            placeholder={detected.name === '' ? acp.label('我的 Agent', 'My Agent') : detected.name}
          />
        </div>
      </div>

      {/* ONE field on purpose: the program and its arguments are one command
          line, exactly as a user would type them. Splitting them into two boxes
          made "paste the whole command into the first box" the default mistake
          (the host then looked for a file named `codebuddy --acp`); here the
          same paste is correct, and the parse preview below shows what will
          actually run (same parser the host's `validateAgentDef` uses). */}
      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('启动命令（程序 + 参数）', 'Launch Command (program + arguments)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            aria-label={acp.label('启动命令（程序 + 参数）', 'Launch Command (program + arguments)')}
            value={form.commandLine}
            onChange={e => patch({ commandLine: e.target.value })}
            placeholder={detected.defaultCommand === ''
              ? 'e.g. codebuddy --acp'
              : formatCommandLine(detected.defaultCommand, detected.defaultArgs)}
          />
          <span className="dwa-hint">{commandPreview}</span>
          <span className="dwa-hint">
            {acp.label(
              '含空格的程序路径请加引号。',
              'Quote the program path if it contains spaces.',
            )}
          </span>
        </div>
      </div>

      <WorkspaceBlock acp={acp} form={form} patch={patch} cwdInvalid={cwdInvalid} rootsInvalid={rootsInvalid} />
      </div>

      <div hidden={!advancedOpen}>
        {!newCustom && (
          <div className="dwa-default-hint">
            <div>
              <span style={{ fontWeight: 600, marginRight: 6 }}>
                {acp.label('官方测试默认命令:', 'Tested Default Command:')}
              </span>
              <code className="dwa-input-mono" style={{ background: 'var(--dsw-alias-markdown-inline-code, #0000000a)', padding: '2px 6px', borderRadius: 4 }}>
                {detected.defaultCommand} {detected.defaultArgs.join(' ')}
              </code>
            </div>
            <button
              type="button"
              className="dwa-btn dwa-btn-secondary"
              onClick={onUseDefault}
              title={acp.label('把命令与参数重置为官方验证值', 'Reset command and arguments to the tested default')}
            >
              {acp.label('使用预设值', 'Use Preset')}
            </button>
          </div>
        )}

      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('npm 包名（PATH 中找不到时自动安装）', 'npm Package (auto-installed when missing from PATH)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            value={form.npmPackage}
            onChange={e => patch({ npmPackage: e.target.value })}
            placeholder={acp.label('原生支持 ACP 的 agent 无需填写', 'Not needed for agents with native ACP support')}
          />
        </div>
      </div>

      {/* Idle release: an OVERRIDE of the global window (「进程管理」). Empty
          means "follow the global window", so the global slider reaches every
          agent that does not pin its own. TWO windows exist
          (AgentBridge.currentIdleTimeoutMs): this field is the chat window of
          a process that HAS hosted a session; a never-used process (a probe)
          always gets the short probe window and ignores this field — which is
          why the copy below names both. */}
      <div className="dwa-form-row">
        <div className="dwa-form-col">
          <label className="dwa-form-label">{acp.label('空闲释放覆盖（毫秒）', 'Idle Release Override (ms)')}</label>
          <input
            className="dwa-input dwa-input-mono"
            aria-label={acp.label('空闲释放覆盖（毫秒）', 'Idle Release Override (ms)')}
            value={form.idleStr}
            onChange={e => patch({ idleStr: e.target.value })}
            placeholder={acp.label(
              `留空 = 跟随全局设置（探测进程固定 ${String(DEFAULT_PROBE_RELEASE_MS / 60_000)} 分钟）`,
              `Blank = follow the global setting (probes always release after ${String(DEFAULT_PROBE_RELEASE_MS / 60_000)} min)`,
            )}
          />
          <span className={idleInvalid ? 'dwa-error' : 'dwa-hint'}>
            {idleInvalid
              ? acp.label(
                '必须是 0（永不释放）或 [1000, 86400000] 之间的整数毫秒。',
                'Must be 0 (never release) or an integer in [1000, 86400000] ms.',
              )
              : (
                <>
                  {acp.label(
                    '仅覆盖此智能体；留空即跟随「进程管理」的全局设置。',
                    'Overrides this agent only; leave blank to follow the global setting in “Processes”.',
                  )}
                </>
              )}
          </span>
        </div>
      </div>

      <div className="dwa-form-row" style={{ flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="dwa-form-label">{acp.label('环境变量', 'Environment Variables')}</span>
          <button
            type="button"
            className="dwa-btn dwa-btn-secondary"
            onClick={() => patch({ envRows: [...form.envRows, { key: '', value: '' }] })}
          >
            {acp.label('添加', 'Add')}
          </button>
        </div>
        {form.envRows.map((row, index) => (
          <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              className="dwa-input dwa-input-mono"
              style={{ flex: 2 }}
              value={row.key}
              onChange={e => patch({ envRows: form.envRows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)) })}
              placeholder="KEY"
            />
            <input
              className="dwa-input dwa-input-mono"
              style={{ flex: 3 }}
              value={row.value}
              onChange={e => patch({ envRows: form.envRows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)) })}
              placeholder="VALUE"
            />
            <button
              type="button"
              className="dwa-btn"
              title={acp.label('删除该变量', 'Remove this variable')}
              onClick={() => patch({ envRows: form.envRows.filter((_, i) => i !== index) })}
            >
              ✕
            </button>
          </div>
        ))}
        {form.envRows.length === 0 && (
          <span className="dwa-hint">
            {acp.label('无自定义变量；子进程继承宿主环境。', 'No custom variables; the child inherits the host environment.')}
          </span>
        )}
      </div>

      <div className="dwa-form-row" style={{ flexDirection: 'column', gap: 6 }}>
        <span className="dwa-form-label">{acp.label('MCP 服务器（JSON）', 'MCP Servers (JSON)')}</span>
        <textarea
          className="dwa-input dwa-input-mono"
          style={{ minHeight: 96, resize: 'vertical' }}
          aria-label={acp.label('MCP 服务器（JSON）', 'MCP Servers (JSON)')}
          value={form.mcpText}
          onChange={e => patch({ mcpText: e.target.value })}
          spellCheck={false}
          placeholder={'[\n  { "name": "example", "transport": "stdio", "command": "/abs/path/to/server", "args": ["--mcp"] }\n]'}
        />
        {mcpInvalid && (
          <span className="dwa-error">
            {acp.label('必须是一个 JSON 数组；每个条目写明 name 与 transport。', 'Must be a JSON array; every entry needs a name and a transport.')}
          </span>
        )}
        <span className="dwa-hint">
          {acp.label(
            '额外追加给智能体的 MCP 服务器，不影响其已有配置。',
            'Additional MCP servers for the agent; its own configuration is unchanged.',
          )}
        </span>
      </div>
      </div>

      {!advancedOpen && (mcpInvalid || idleInvalid) && <p className="dwa-error" role="alert">{acp.label('请检查「高级」中的无效配置。', 'Check the invalid settings in Advanced.')}</p>}
      {advancedOpen && (!idValid || idTaken || cwdInvalid || rootsInvalid || parsedCommand.command === '') && <p className="dwa-error" role="alert">{acp.label('请检查「连接」中的未完成或无效配置。', 'Check the incomplete or invalid settings in Connection.')}</p>}
      <div className="dwa-form-actions">
        <span className="dwa-hint">{isConfigured ? dirty ? acp.label('有未保存的更改', 'Unsaved changes') : acp.label('配置已保存', 'Settings saved') : ''}</span>
        <button
          className="dwa-btn"
          onClick={onTest}
          disabled={testing || saving || formIncomplete}
          title={acp.label('用当前表单值拉起一次性进程并完成 ACP 握手，不保存配置', 'Spawns a throwaway process from the form values and completes the ACP handshake; nothing is saved')}
        >
          {testing ? acp.label('测试中...', 'Testing...') : acp.label('测试连接', 'Test Connection')}
        </button>

        <button
          className="dwa-btn dwa-btn-primary"
          onClick={onSave}
          disabled={saving || testing || formIncomplete || (isConfigured && !dirty)}
        >
          {saving
            ? acp.label('保存中...', 'Saving...')
            : savedSuccess
              ? acp.label('✓ 已保存', '✓ Saved')
              : isConfigured
                ? acp.label('保存更改', 'Save changes')
                : acp.label('保存并启用', 'Save & Enable')}
        </button>

        {showSaveWarning && (
          <span className="dwa-hint" style={{ color: 'var(--ntr-warn)' }}>
            ⚠ {acp.label('保存会停止该 Agent 进程并中断进行中的会话', 'Saving stops this agent process and interrupts live sessions')}
          </span>
        )}
      </div>

      {testResult !== undefined && (
        <div
          className="dwa-mono"
          style={{
            marginTop: 8,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            color: testResult.ok ? 'var(--ntr-success)' : 'var(--ntr-danger)',
          }}
        >
          {testResult.ok ? '✓ ' : '✕ '}{testResult.text}
        </div>
      )}
    </div>
  )
}

/**
 * Workspace editor. Single-root mode is one directory; the advanced switch
 * reveals the full allow-list, because the host enforces every root the agent
 * may touch (and refuses anything else with `cwd_denied`).
 */
function WorkspaceBlock({
  acp,
  form,
  patch,
  cwdInvalid,
  rootsInvalid,
}: {
  acp: AcpStore
  form: AgentForm
  patch: (next: Partial<AgentForm>) => void
  cwdInvalid: boolean
  rootsInvalid: boolean
}) {
  return (
    <div className="dwa-form-row" style={{ flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="dwa-form-label">{acp.label('工作空间根目录', 'Workspace Roots')}</span>
        <label className="dwa-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.rootsOpen}
            onChange={e => patch({ rootsOpen: e.target.checked })}
            style={{ margin: 0 }}
          />
          {acp.label('白名单根目录（高级）', 'Root allow-list (advanced)')}
        </label>
      </div>

      <div className="dwa-form-col">
        <input
          className="dwa-input"
          value={form.cwd}
          onChange={e => patch({ cwd: e.target.value })}
          placeholder={acp.label('默认 ~/.dsh/dsh-ntr/workspaces', 'Default: ~/.dsh/dsh-ntr/workspaces')}
        />
        {cwdInvalid && (
          <span className="dwa-error">{acp.label('必须是绝对路径（如 /work 或 C:\\work）', 'Must be an absolute path (e.g. /work or C:\\work)')}</span>
        )}
        <span className="dwa-hint">
          {acp.label(
            '聊天使用会话工作区；此处用于直连会话或宿主未提供工作区时。',
            'Chats use their session workspace; this applies to direct sessions or when the host provides no workspace.',
          )}
        </span>
        {/* The effective allow-list stays visible in single-root mode too:
            saving there deliberately narrows it to this one directory. */}
        {!form.rootsOpen && (
          <span className="dwa-hint">
            {acp.label('当前白名单：', 'Current allow-list: ')}
            {form.roots.length === 0 ? acp.label('（未设置）', '(unset)') : form.roots.join('、')}
            {form.cwd.trim() === '' ? '' : acp.label('；保存时将收窄为工作空间目录', '; saving narrows it to the workspace directory')}
          </span>
        )}
      </div>

      {form.rootsOpen && (
        <div className="dwa-form-col" style={{ gap: 4 }}>
          {form.roots.map((root, index) => (
            <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                className="dwa-input dwa-input-mono"
                value={root}
                onChange={e => patch({ roots: form.roots.map((r, i) => (i === index ? e.target.value : r)) })}
                placeholder="/absolute/path"
              />
              <button
                type="button"
                className="dwa-btn"
                title={acp.label('删除该根目录', 'Remove this root')}
                onClick={() => patch({ roots: form.roots.filter((_, i) => i !== index) })}
              >
                ✕
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="dwa-btn dwa-btn-secondary"
              onClick={() => patch({ roots: [...form.roots, ''] })}
            >
              {acp.label('添加根目录', 'Add root')}
            </button>
            <span className="dwa-hint">
              {acp.label('留空的工作空间则使用宿主默认目录。', 'An empty workspace falls back to the host default directory.')}
            </span>
          </div>
          {rootsInvalid && (
            <span className="dwa-error">
              {acp.label('至少需要一个绝对路径根目录', 'At least one absolute root is required')}
            </span>
          )}
        </div>
      )}

      <span className="dwa-hint">
        {acp.label(
          '白名单之外的路径会被宿主拒绝（cwd_denied）；当前 DSH 会话自己的工作区始终被信任。',
          'Paths outside the allow-list are refused by the host (cwd_denied); the current DSH session\u2019s own workspace is always trusted.',
        )}
      </span>
    </div>
  )
}

/** Row overflow menu: the dangerous actions, plus the inline remove confirm. */
function RowMenu({
  acp,
  canStop,
  onStop,
  onRemove,
}: {
  acp: AcpStore
  canStop: boolean
  onStop: () => void
  onRemove: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrap.current !== null && event.target instanceof Node && wrap.current.contains(event.target)) return
      setOpen(false)
      setConfirming(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setConfirming(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const close = (): void => {
    setOpen(false)
    setConfirming(false)
  }

  return (
    <div className="dwa-menu-wrap" ref={wrap}>
      <button
        type="button"
        className="dwa-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={acp.label('更多操作', 'More actions')}
        onClick={() => {
          setOpen(value => !value)
          setConfirming(false)
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="dwa-menu" role="menu">
          {canStop && (
            <button
              type="button"
              role="menuitem"
              className="dwa-menu-item"
              onClick={() => {
                close()
                onStop()
              }}
            >
              {acp.label('停止当前运行实例', 'Stop Running Process')}
            </button>
          )}
          {confirming ? (
            <div className="dwa-menu-confirm">
              <button
                type="button"
                className="dwa-btn dwa-btn-danger"
                onClick={() => {
                  close()
                  void onRemove()
                }}
              >
                {acp.label('确认移除？', 'Confirm remove?')}
              </button>
              <button type="button" className="dwa-btn" onClick={() => setConfirming(false)}>
                {acp.label('取消', 'Cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="dwa-btn dwa-menu-item dwa-menu-item-danger"
              onClick={() => setConfirming(true)}
            >
              {acp.label('移除配置', 'Remove')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Measure the id cell on row hover so its CSS marquee can reach the end of the
 * text. The id is the only cell that yields width, and the panel is resizable,
 * so the overflow is re-read on every entry rather than cached. The animation
 * itself lives in CSS and only runs while the row is hovered; `title` on the
 * row stays the fallback for reduced-motion users.
 */
function armModelIdMarquee(row: HTMLElement): void {
  const view = row.querySelector<HTMLElement>('.dwa-model-row-value')
  const text = view?.querySelector<HTMLElement>('.dwa-model-row-value-text')
  if (view === null || view === undefined || text === null || text === undefined) return
  const fade = Number.parseFloat(getComputedStyle(view).paddingRight) || 0
  const shift = Math.max(0, text.offsetWidth - (view.clientWidth - fade))
  row.style.setProperty('--dwa-id-shift', `${String(-shift)}px`)
  row.style.setProperty('--dwa-id-duration', `${String(Math.min(4, Math.max(1.2, shift / 30)))}s`)
}

/**
 * Model / thought-level catalog display plus the native-selector visibility
 * filter, as a two-pane transfer list: every known model on the left, the
 * selection that reaches the NTR surfaces on the right. Variants are still
 * opt-in — an empty selection is a legitimate state (base entry only) — and
 * edits save themselves (debounced), so there is no apply button and no second
 * dirty state to lose track of.
 *
 * The panes are ALWAYS shown, never gated on a probe: the right side comes from
 * the agent definition (`exposedModels`) and the left from the host's persisted
 * catalog cache, so opening the card shows what is already configured instead
 * of an empty box that costs one click per visit. 「检测可用模型」 therefore
 * sits with the list and acts as a REFRESH of the left pane only — models the
 * agent newly publishes appear, models it stopped advertising drop out.
 *
 * The auto-discovery switch is a per-agent POLICY, not a one-shot action: it
 * appends models the agent NEWLY publishes to the selection (see
 * `AcpAgentDef.autoDiscoverModels`). It saves itself through the lightweight
 * RPC, so flipping it never restarts the agent process.
 */
function ModelCatalogBlock({
  agentId,
  detected,
  acp,
  active,
  exposed,
  onExposedChange,
  autoDiscover,
  onAutoDiscoverChange,
  isDefault,
}: {
  agentId: string
  detected: DetectedAgentInfo
  acp: AcpStore
  /** The card's body is visible; the display read waits for the first expand. */
  active: boolean
  exposed: string[] | undefined
  onExposedChange: (next: string[] | undefined) => void
  autoDiscover: boolean
  onAutoDiscoverChange: (next: boolean) => void
  isDefault: boolean
}) {
  const ui = useUi(acp)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string[] | undefined>(undefined)
  const hasPending = useRef(false)
  // In-flight auto-discovery toggle. A ref, not state: the switch saves
  // silently, and a "saving" render here made the row wrap and snap back
  // (user report, 2026-10-21). The guard only prevents double-submits.
  const autoDiscoverBusy = useRef(false)
  // Latest host-confirmed filter: the rollback target when a save fails.
  const serverValue = useRef(exposed)
  serverValue.current = detected.currentConfig?.exposedModels

  const probing = ui.probingModels[agentId] === true
  const probeError = ui.probeErrors[agentId]
  const result = ui.modelCatalogs[agentId]
  const modelChoices = result?.catalog.model?.choices ?? []
  /** Result of the last click on 「检测可用模型」 (what the refresh changed). */
  const [detectNote, setDetectNote] = useState<string | undefined>(undefined)
  // Each list folds on its own so a long selection can be parked while the
  // other pane keeps the full column. The list stays mounted (display-toggled)
  // to keep its scroll position.
  const [allCollapsed, setAllCollapsed] = useState(false)
  const [selectedCollapsed, setSelectedCollapsed] = useState(false)

  // Display read, not a probe: the host answers from its persisted catalog
  // cache, so the panes already list the known models the first time the card
  // opens. Gated on `active` because every configured agent's body stays
  // mounted (display-toggled) and a collapsed card has nothing to show.
  useEffect(() => {
    if (!active) return
    void acp.loadCachedModels(agentId)
  }, [active, agentId])

  useEffect(() => () => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    // Flush a pending edit instead of dropping it with the unmount (the
    // panel can be closed mid-debounce); the host keeps the last word.
    if (!hasPending.current) return
    hasPending.current = false
    void acp.setExposedModels(agentId, pending.current).catch(() => { /* host keeps its value */ })
  }, [])

  const rollback = (error: unknown): void => {
    onExposedChange(serverValue.current === undefined ? undefined : [...serverValue.current])
    setSaveError(error instanceof Error ? error.message : String(error))
  }

  /** Persist a filter now (mode switch); a failure restores the editor. */
  const commit = async (next: string[] | undefined): Promise<void> => {
    setSaveError(undefined)
    try {
      await acp.setExposedModels(agentId, next)
      onExposedChange(next)
    } catch (error) {
      rollback(error)
    }
  }

  /** Persist selection edits after a short idle — several clicks coalesce into one call. */
  const queueExposure = (next: string[]): void => {
    pending.current = next
    hasPending.current = true
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!hasPending.current) return
      hasPending.current = false
      void commit(pending.current)
    }, EXPOSURE_SAVE_DEBOUNCE_MS)
  }

  const toggleAutoDiscover = async (next: boolean): Promise<void> => {
    if (autoDiscoverBusy.current) return
    autoDiscoverBusy.current = true
    onAutoDiscoverChange(next)
    setSaveError(undefined)
    try {
      await acp.setAutoDiscoverModels(agentId, next)
    } catch (error) {
      onAutoDiscoverChange(!next)
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      autoDiscoverBusy.current = false
    }
  }

  const query = search.trim().toLowerCase()
  const visibleChoices = query === ''
    ? modelChoices
    : modelChoices.filter(choice =>
      choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query))

  // Unset means "nothing selected", not "everything": an unset filter and an
  // empty one are the same host-side state (base entry only).
  const basis = exposed ?? []
  const selected = new Set(basis)
  // Right pane = selection in catalog order, then any selected value the last
  // probe no longer lists (still saved and still usable — hiding it would make
  // the two panes quietly disagree about what is configured).
  const selectedChoices: AcpCatalogChoice[] = []
  for (const choice of modelChoices) if (selected.has(choice.value)) selectedChoices.push(choice)
  const listed = new Set(selectedChoices.map(choice => choice.value))
  for (const value of basis) if (!listed.has(value)) selectedChoices.push({ value, name: value })
  const selectedInCatalog = basis.filter(value => modelChoices.some(choice => choice.value === value)).length

  const apply = (next: string[]): void => {
    onExposedChange(next)
    queueExposure(next)
  }

  const toggleChoice = (value: string): void => {
    apply(selected.has(value) ? basis.filter(v => v !== value) : [...basis, value])
  }

  /** Add every model matching the current search that is not selected yet. */
  const addVisible = (): void => {
    const added = visibleChoices.map(choice => choice.value).filter(value => !selected.has(value))
    if (added.length === 0) return
    apply([...basis, ...added])
  }

  const clearAll = (): void => {
    if (basis.length === 0) return
    apply([])
  }

  /**
   * Refresh the left pane from the agent: re-probe, then report what moved.
   * The note is what makes the button legible — a refresh that changes nothing
   * looks identical to a dead button otherwise (the catalog `updatedAt` does
   * not even move, since the host keeps the entry when the answer is equal).
   */
  const detect = async (): Promise<void> => {
    const before = new Set(modelChoices.map(choice => choice.value))
    setDetectNote(undefined)
    await acp.probeModels(agentId)
    const state = acp.getSnapshot()
    if (state.probeErrors[agentId] !== undefined) return
    const after = state.modelCatalogs[agentId]?.catalog.model?.choices ?? []
    const afterValues = new Set(after.map(choice => choice.value))
    const added = after.filter(choice => !before.has(choice.value)).length
    const removed = [...before].filter(value => !afterValues.has(value)).length
    setDetectNote(added === 0 && removed === 0
      ? acp.label('目录无变化', 'Catalog unchanged')
      : acp.label(
        `新增 ${String(added)} · 移除 ${String(removed)}`,
        `${String(added)} added · ${String(removed)} removed`,
      ))
  }

  const selectionBadge = modelChoices.length > 0
    ? acp.label(
      `已选 ${String(selectedInCatalog)}/${String(modelChoices.length)}`,
      `Selected ${String(selectedInCatalog)}/${String(modelChoices.length)}`,
    )
    : acp.label(`已选 ${String(basis.length)}`, `Selected ${String(basis.length)}`)

  // Freshness of the cached list (a probe that finds nothing new keeps the old
  // stamp by design — see `detect`), superseded by the click's own outcome.
  const catalogStatus = detectNote ?? (
    result !== undefined && result.updatedAt > 0
      ? acp.label(`目录更新于 ${formatStamp(result.updatedAt)}`, `Catalog from ${formatStamp(result.updatedAt)}`)
      : undefined
  )

  const leftEmptyCopy = visibleChoices.length > 0
    ? undefined
    : modelChoices.length > 0
      ? acp.label('无匹配模型', 'No matching models')
      : result === undefined
        ? acp.label('尚未读取模型目录，点「检测可用模型」从 Agent 读取。', 'No catalog yet — click "Detect available models" to read it from the agent.')
        : acp.label('该 Agent 未暴露模型选择器（category: model）。', 'This agent exposes no model selector (category: model).')

  return (
    <div>
      {!isDefault && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="dwa-btn" onClick={() => void acp.setDefaultAgent(agentId)}>
            {acp.label('设为默认智能体', 'Set as default agent')}
          </button>
        </div>
      )}
      {isDefault && (
        // This default belongs to the plugin, not the deployment model route.
        <div className="dwa-hint" style={{ marginTop: 8 }}>
          {acp.label(
            '当前为默认智能体：新的 NTR 会话由它服务，不影响其他模式的默认模型。',
            "This is the default agent for new NTR sessions; other modes' default models are untouched.",
          )}
        </div>
      )}

      <div className="dwa-inline-setting" style={{ marginTop: 12 }}>
        <label
          className="dwa-switch"
          title={acp.label(
            'Agent 新发布的模型会自动加入右侧已选列表；首次检测到的目录只作为基线，不会一次性全选。',
            'Models the agent newly publishes are added to the selected list; the first observed catalog is only a baseline and is not selected wholesale.',
          )}
        >
          <input
            type="checkbox"
            checked={autoDiscover}
            onChange={e => void toggleAutoDiscover(e.target.checked)}
            style={{ margin: 0, accentColor: 'var(--dsw-alias-state-business-primary, #2563eb)' }}
          />
          {acp.label('自动发现新模型', 'Auto-discover new models')}
        </label>
        <span className="dwa-setting-copy">
          {acp.label('新增模型自动加入已选列表，现有勾选不受影响。', 'New models join the selected list automatically; existing picks are untouched.')}
        </span>
      </div>
      {saveError !== undefined && <div className="dwa-error" style={{ marginTop: 4 }}>{saveError}</div>}
      {probeError !== undefined && (
        <div className="dwa-error" style={{ marginTop: 8, wordBreak: 'break-word' }}>
          ⚠ {acp.label('模型检测失败：', 'Model detection failed: ')}{probeError}
        </div>
      )}

      {/* Always rendered, never gated on a probe: the selection is known from
          the agent definition and the left list from the host's persisted
          catalog cache. A card that only fills in after a click makes the
          configured state invisible on every visit. */}
      <div className="dwa-model-section">
        <div className="dwa-model-toolbar">
          <span className="dwa-form-label">
            {acp.label('对话中可见的模型', 'Models offered in the conversation')}
            <span
              className="dwa-hint"
              style={{ marginLeft: 6, fontWeight: 400 }}
              title={acp.label(
                'NTR 模式下的对话只列出这里勾选的模型；未勾选的仍可用——正在生效的那个也会以「· 当前」列出来，其余不列出。',
                'The NTR surfaces only list what is checked here; unchecked models still work, and the one currently in force is still listed with a "· current" row — the rest are not offered.',
              )}
            >
              {acp.label('仅影响菜单可见性', 'Menu visibility only')}
            </span>
          </span>
          <span className="dwa-badge dwa-badge-info">{selectionBadge}</span>
          {/* Freshness of the list stays on the header line, right-aligned; the
              controls below it wrap as one unit. */}
          {catalogStatus !== undefined && <span className="dwa-hint dwa-model-status">{catalogStatus}</span>}
          <div className="dwa-model-toolbar-actions">
            {/* Sits with the list it acts on: a refresh of the LEFT pane only.
                Detection is not what reveals the models — the cache read above
                already does — so keeping it at the top made it read as the
                price of seeing anything at all. */}
            <button
              type="button"
              className="dwa-btn dwa-btn-secondary"
              disabled={probing}
              onClick={() => void detect()}
              title={acp.label(
                '重新读取 Agent 的模型目录：新增的加入左侧，已下架的从左侧移除；已选列表不受影响。',
                'Re-read the agent catalog: newly published models join the left list, withdrawn ones drop out. The selection is untouched.',
              )}
            >
              {probing ? acp.label('模型检测中...', 'Probing models...') : acp.label('检测可用模型', 'Detect available models')}
            </button>
            {/* The filter lives above BOTH panes, not inside the left one: a
                search field between the pane head and its list made that pane
                structurally taller, so the two could never share one height. */}
            <input
              className="dwa-input dwa-model-search"
              aria-label={acp.label('搜索模型', 'Search models')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={acp.label('搜索模型…', 'Search models…')}
            />
          </div>
        </div>

        <div className="dwa-model-transfer">
          <div className={`dwa-model-pane${allCollapsed ? ' is-collapsed' : ''}`}>
            <div className="dwa-model-pane-head">
              <span>{acp.label('全部模型', 'All models')}</span>
              {result !== undefined && <span className="dwa-badge">{modelChoices.length}</span>}
              <button
                type="button"
                className="dwa-btn dwa-btn-secondary"
                disabled={visibleChoices.length === 0}
                onClick={addVisible}
                title={acp.label('把当前搜索范围内的模型全部加入右侧', 'Add every model matching the current search')}
              >
                {acp.label('全部加入', 'Add all')}
              </button>
              <button
                type="button"
                className="dwa-caret-btn"
                aria-expanded={!allCollapsed}
                onClick={() => setAllCollapsed(value => !value)}
                title={allCollapsed ? acp.label('展开全部模型', 'Expand all models') : acp.label('收起全部模型', 'Collapse all models')}
              >
                <span className="dwa-caret" aria-hidden>{allCollapsed ? '▸' : '▾'}</span>
              </button>
            </div>
            <div className="dwa-model-list">
              {visibleChoices.map(choice => {
                const checked = selected.has(choice.value)
                // group 前缀仅来自 agent 返回的 SessionConfigSelectGroup（见 impl.ts
                // pushCatalogChoice）；供应商可见性兜底靠原样展示 value，严禁从
                // value 路径截取供应商段做标签（约束 8）。
                const title = choice.description === undefined
                  ? choice.value
                  : `${choice.value}\n${choice.description}`
                return (
                  <button
                    type="button"
                    key={choice.value}
                    className={`dwa-model-row${checked ? ' is-on' : ''}`}
                    title={title}
                    onClick={() => toggleChoice(choice.value)}
                    onPointerEnter={event => { armModelIdMarquee(event.currentTarget) }}
                  >
                    <span className="dwa-model-row-mark">{checked ? '✓' : '+'}</span>
                    <span className="dwa-model-row-name">
                      {choice.group !== undefined && <span style={{ opacity: 0.7 }}>{choice.group} · </span>}
                      {choice.name}
                    </span>
                    {choice.value !== choice.name && (
                      <span className="dwa-model-row-value">
                        <span className="dwa-model-row-value-text">{choice.value}</span>
                      </span>
                    )}
                    {/* Credit / capability notes belong on the row itself: the
                        list exists to compare models, and a hover-only price
                        cannot be scanned. Grouped choices reuse the group label
                        as their fallback description — that one is already
                        printed before the name. */}
                    {choice.description !== undefined && choice.description !== choice.group && (
                      <span className="dwa-model-row-desc">{choice.description}</span>
                    )}
                  </button>
                )
              })}
              {leftEmptyCopy !== undefined && <span className="dwa-hint dwa-model-empty">{leftEmptyCopy}</span>}
            </div>
          </div>

          <div className={`dwa-model-pane${selectedCollapsed ? ' is-collapsed' : ''}`}>
            <div className="dwa-model-pane-head">
              <span>{acp.label('已选模型', 'Selected models')}</span>
              <span className="dwa-badge dwa-badge-info">{basis.length}</span>
              <button
                type="button"
                className="dwa-btn dwa-btn-secondary"
                disabled={basis.length === 0}
                onClick={clearAll}
              >
                {acp.label('清空', 'Clear')}
              </button>
              <button
                type="button"
                className="dwa-caret-btn"
                aria-expanded={!selectedCollapsed}
                onClick={() => setSelectedCollapsed(value => !value)}
                title={selectedCollapsed ? acp.label('展开已选模型', 'Expand selected models') : acp.label('收起已选模型', 'Collapse selected models')}
              >
                <span className="dwa-caret" aria-hidden>{selectedCollapsed ? '▸' : '▾'}</span>
              </button>
            </div>
            <div className="dwa-model-list">
              {selectedChoices.length === 0 && (
                <span className="dwa-hint dwa-model-empty">
                  {acp.label('尚未选择模型，从「全部模型」中加入。', 'No models selected. Add from All models.')}
                </span>
              )}
              {selectedChoices.map(choice => (
                <button
                  type="button"
                  key={choice.value}
                  className="dwa-model-row is-on"
                  title={choice.description === undefined ? choice.value : `${choice.value}\n${choice.description}`}
                  onClick={() => toggleChoice(choice.value)}
                  onPointerEnter={event => { armModelIdMarquee(event.currentTarget) }}
                >
                  <span className="dwa-model-row-name">
                    {choice.group !== undefined && <span style={{ opacity: 0.7 }}>{choice.group} · </span>}
                    {choice.name}
                  </span>
                  {choice.value !== choice.name && (
                    <span className="dwa-model-row-value">
                      <span className="dwa-model-row-value-text">{choice.value}</span>
                    </span>
                  )}
                  {choice.description !== undefined && choice.description !== choice.group && (
                    <span className="dwa-model-row-desc">{choice.description}</span>
                  )}
                  <span className="dwa-model-row-remove" aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {result?.catalog.thought !== undefined && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="dwa-form-label">{acp.label('思考等级', 'Thought Levels')}</span>
            {result.catalog.thought.choices.map(choice => (
              <span key={choice.value} className="dwa-badge" title={choice.description}>
                {choice.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
