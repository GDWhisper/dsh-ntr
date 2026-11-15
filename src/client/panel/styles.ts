/**
 * The settings page's stylesheet.
 *
 * One string, injected once per document: the host's micro-frontend gives the
 * plugin no CSS entry point, so `ensureStyle` appends a `<style>` node on the
 * first render of the section. The module-level `styleMounted` guard is what
 * keeps a remount from stacking a second copy of every rule.
 *
 * Colors follow constraint 34: host alias tokens first, literals only inside a
 * `var()` fallback.
 */
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
/* The release-notes preview: its own block under the card's copy, with a
   separator so a long body never reads as part of the sentence above it. The
   body scrolls (40vh) instead of stretching the card; every rule below uses a
   host token, with a light fallback only where the host may lack one. */
.dwa-update-notes { margin-top: 12px; padding-top: 12px; border-top: var(--ntr-line); display: grid; gap: 6px; }
.dwa-update-notes-head { margin: 0; font-size: var(--ntr-font-xs); font-weight: 550; }
.dwa-update-notes-body { max-height: 40vh; overflow: auto; font-size: var(--ntr-font-xs); line-height: 1.6; overflow-wrap: anywhere; }
.dwa-update-notes-body > :first-child { margin-top: 0; }
.dwa-update-notes-body > :last-child { margin-bottom: 0; }
.dwa-update-notes-body h4, .dwa-update-notes-body h5, .dwa-update-notes-body h6 { margin: 10px 0 4px; font-size: 1em; font-weight: 600; }
.dwa-update-notes-body p { margin: 6px 0; }
.dwa-update-notes-body ul { margin: 6px 0; padding-left: 18px; }
.dwa-update-notes-body li { margin: 2px 0; }
.dwa-update-notes-body code { font-family: var(--ds-font-family-code, ui-monospace, monospace); background: var(--dsw-alias-markdown-inline-code, rgba(0, 0, 0, 0.06)); border-radius: 4px; padding: 0 3px; }
.dwa-update-notes-body a { color: var(--dsw-alias-button-primary-fill, #2563eb); text-decoration: underline; }
.dwa-update-notes-url { color: var(--ntr-muted); font-size: var(--ntr-font-xs); overflow-wrap: anywhere; }
.dwa-update-notes-url a { color: inherit; text-decoration: underline; }
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
.dwa-save-confirm { margin-top: 12px; }
.dwa-save-confirm-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.dwa-save-confirm-sessions { word-break: break-all; }
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
/* The settings rows' info icon: a real focusable button (keyboard users reach
   the tooltip through it), drawn as a quiet glyph so it never competes with
   the row's own label. */
.dwa-info-btn { flex-shrink: 0; width: 16px; height: 16px; padding: 0; margin-top: 2px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 50%; background: none; color: var(--dsw-alias-label-tertiary, #6b7280); font: inherit; font-size: 10px; line-height: 1; font-style: italic; cursor: help; display: inline-flex; align-items: center; justify-content: center; }
.dwa-info-btn:hover, .dwa-info-btn:focus-visible { color: var(--dsw-alias-label-primary, #111827); border-color: var(--dsw-alias-label-tertiary, #9ca3af); }
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
export function ensureStyle(): void {
  if (styleMounted || typeof document === 'undefined') return
  styleMounted = true
  const node = document.createElement('style')
  node.textContent = STYLE
  document.head.appendChild(node)
}
