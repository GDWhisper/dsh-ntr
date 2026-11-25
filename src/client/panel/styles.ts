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
  --ntr-radius: 12px; --ntr-radius-sm: 8px;
  --ntr-font: 13px; --ntr-font-sm: 12px; --ntr-font-xs: 11px;
  --ntr-line: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  /* Row dividers INSIDE a card: one step lighter than a card's own edge, so a
     card reads as one surface and its rows read as its contents. */
  --ntr-line-quiet: 1px solid var(--dsw-alias-border-l3, #eef0f3);
  /* The only elevation in the panel. Kept literal on purpose: the host theme
     publishes colours, not shadows, so a token here would be invented.
     Black, not a tinted near-black: §11 exempts exactly this form, and a
     shadow is not an ink color that has to follow the theme. */
  --ntr-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 1px rgba(0, 0, 0, 0.02);
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
.dwa-root button:focus-visible, .dwa-root input:focus-visible, .dwa-root select:focus-visible, .dwa-root textarea:focus-visible {
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
/* ── The panel's one grammar: label → card → row ──────────────────────────
 * Three levels, three treatments, and nothing else:
 *   label  a small secondary-ink line above a card (.dwa-section-title);
 *   card   the only elevated surface, and cards never nest (a block that
 *          needs its own boundary becomes its own card, listed under the
 *          section's first one);
 *   row    a divider-separated band inside one card (.dwa-preference-*).
 * Before this, every control sat in the same white slab separated by uniform
 * 1px rules at 14 / 13 / 12px of bold, so a section, an agent and a field all
 * looked like peers. */
.dwa-section { margin-bottom: 28px; }
.dwa-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.dwa-section-title { font-size: var(--ntr-font-sm); font-weight: 650; margin: 0; display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #4b5563); }
/* 子智能体委派配置 is a SECOND label of the 子智能体 page, not a title inside a card: it
 * sits at the same weight as the page's own section label, because its cards
 * are siblings of that section's card. */
.dwa-subsection-title { font-size: var(--ntr-font-sm); font-weight: 650; color: var(--dsw-alias-label-secondary, #4b5563); }
.dwa-section-copy { margin: 3px 0 0; font-size: var(--ntr-font-xs); color: var(--ntr-muted); }
.dwa-card { border: var(--ntr-line); border-radius: var(--ntr-radius); padding: 16px; background: var(--dsw-alias-bg-layer-1, #fff); font-size: var(--ntr-font); line-height: 1.55; }
/* A card's own title and one-line copy (used where the card IS the section). */
.dwa-row-title { margin: 0; font-size: var(--ntr-font); font-weight: 600; color: var(--dsw-alias-label-primary, #111827); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dwa-row-desc { margin: 2px 0 0; font-size: var(--ntr-font-sm); color: var(--ntr-muted); }
/* Label/copy on one side, the control on the other; wraps to a stack before it
 * squeezes either half. */
.dwa-row-split { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dwa-row-main { min-width: 0; flex: 1 1 220px; }
.dwa-row-side { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; }
/* A select on the row's right: wide enough to read a model name, and capped so
   a long「默认（…）」option cannot stretch the row past the card. A CLASS, not an
   inline style — an inline flex-basis survives the stack-to-column query below,
   where that basis would become a 320px-tall empty box above the control. */
.dwa-row-side-select { flex: 0 1 320px; min-width: 200px; }
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
/* The agent roster is ONE card, and each agent is a row inside it — the same
 * grammar as every other settings section, so the 智能体 page stops being a
 * bare list separated by rules. NO overflow clipping here on purpose: the
 * ⋯ menu (.dwa-menu, absolute inside a relatively positioned wrapper) is
 * painted past the last row, and clipping the card would cut the whole menu —
 * including its「确认移除？」confirmation — off at the bottom edge. Nothing in a
 * row touches the rounded corners, so the radius needs no clip to hold. */
.dwa-agent-list { display: flex; flex-direction: column; border: var(--ntr-line); border-radius: var(--ntr-radius); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--ntr-shadow); }
.dwa-agent-card { min-width: 0; }
.dwa-agent-card + .dwa-agent-card { border-top: var(--ntr-line-quiet); }
.dwa-agent-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 12px 16px; }
.dwa-agent-avatar { display: grid; place-items: center; width: 38px; height: 38px; border: var(--ntr-line); border-radius: 9px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--ntr-muted); font: 12px var(--ds-font-family-code, monospace); }
.dwa-caret { font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; width: 1em; }
.dwa-caret-btn { font: inherit; border: none; background: var(--dsw-alias-bg-layer-2, #f3f4f6); width: 28px; height: 28px; padding: 0; border-radius: var(--ntr-radius-sm); display: inline-flex; align-items: center; justify-content: center; color: var(--ntr-muted); cursor: pointer; }
.dwa-caret-btn:hover { background: var(--dsw-alias-interactive-bg-active, #e5e7eb); color: inherit; }
.dwa-agent-summary { min-width: 0; }
.dwa-agent-titleline { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.dwa-agent-name { font-size: 13px; font-weight: 550; overflow-wrap: anywhere; }
.dwa-agent-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
.dwa-agent-meta-separator { opacity: 0.45; }
/* The detail body lines up with the row's own text column: 16px card inset +
   38px avatar + 14px gap. */
.dwa-agent-body { padding: 4px 16px 18px 68px; }
.dwa-subsection { min-width: 0; }
.dwa-form-row { display: flex; gap: var(--ntr-gap-3); margin-bottom: 14px; align-items: stretch; }
.dwa-form-col { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
/* Field labels sit one step below a row title and use secondary ink: primary
   ink is reserved for the thing the row IS (its title, an agent's name), so a
   form of eight labels cannot compete with the card's own hierarchy. */
.dwa-form-label { font-size: var(--ntr-font-sm); font-weight: 600; color: var(--dsw-alias-label-secondary, #4b5563); }
.dwa-hint { font-size: var(--ntr-font-xs); line-height: 1.55; color: var(--ntr-muted); }
.dwa-error { font-size: var(--ntr-font-xs); color: var(--ntr-danger); }
.dwa-input { min-height: 36px; font: inherit; font-size: var(--ntr-font-sm); padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; width: 100%; box-sizing: border-box; }
.dwa-select { min-height: 32px; font: inherit; font-size: var(--ntr-font-sm); padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; width: 100%; box-sizing: border-box; max-width: 100%; }
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
/* The capsule switch (DSH 技能发现, both levels): a track with a knob that
   slides. The real checkbox covers the track and stays transparent, so the
   pointer, the keyboard and assistive tech keep the platform's own behaviour;
   the track and the knob are plain spans. Colours are host alias tokens
   (constraint 34), and the global reduced-motion rule already kills the two
   transitions below. The off track uses a LABEL token rather than a border one
   on purpose: the white knob is what says "off", and it needs 3:1 against the
   track (WCAG 1.4.11) — the border greys are lighter than that. */
.dwa-pill { position: relative; display: inline-flex; flex: none; cursor: pointer; }
.dwa-pill input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.dwa-pill-track { display: inline-flex; align-items: center; box-sizing: border-box; width: 34px; height: 20px; padding: 2px; border-radius: 999px; background: var(--dsw-alias-label-tertiary, #6b7280); transition: background 0.15s ease; }
.dwa-pill-knob { width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1, #fff); transition: transform 0.15s ease; }
.dwa-pill input:checked + .dwa-pill-track { background: var(--ntr-accent); }
.dwa-pill input:checked + .dwa-pill-track .dwa-pill-knob { transform: translateX(14px); }
/* The input is transparent, so its own outline would be too: the ring goes on
   the track the user actually sees. */
.dwa-pill input:focus-visible + .dwa-pill-track { outline: 2px solid var(--ntr-accent); outline-offset: 2px; }
.dwa-inline-setting { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-bg-layer-2, #f9fafb); }
.dwa-inline-setting .dwa-switch { flex-shrink: 0; margin-top: 1px; }
/* The DSH 技能发现 master card: one row — the capability and its one-line copy
   on the left, the switch on the right. It owns the 技能 page, so nothing here
   is positioned relative to the agent roster; the per-agent list below it is a
   separate block, not part of this card. */
.dwa-skills-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; box-shadow: var(--ntr-shadow); }
.dwa-skills-card-text { min-width: 0; }
/* The switch's side of the card: centred, so the info icon loses the top margin
   it needed when the card stacked its contents. */
.dwa-skills-card-control { display: inline-flex; align-items: center; gap: 10px; flex: none; }
.dwa-skills-card-control .dwa-info-btn { margin-top: 0; }
/* The per-agent opt-outs listed under the master card: the same row visual
   language the other settings rows use, so the list reads as the card's
   continuation instead of a second section with its own heading. The surface
   itself is declared with the other card rules, near the end of the sheet. */
/* The row's right side: the switch plus a fixed-width warning slot beside it,
   so a warning appearing changes colour only, never the layout. */
.dwa-skills-row-control { display: inline-flex; align-items: center; gap: 8px; }
/* The red exclamation that pops when a row is turned ON while the master switch
   is off. Host alias token for the colour (constraint 34); the same circled
   glyph shape as the info icon, in danger ink so it reads as a warning. */
.dwa-skills-warn { flex: none; width: 18px; height: 18px; padding: 0; border: 1px solid var(--ntr-danger); border-radius: 50%; background: none; color: var(--ntr-danger); font: inherit; font-size: 12px; font-weight: 700; line-height: 1; cursor: help; display: inline-flex; align-items: center; justify-content: center; }
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
/* Every settings row on every page lives in one of these: the card is the
 * surface, a row is a band inside it, and the divider between rows is one step
 * lighter than the card's own edge. The container owns the boundary now, which
 * is why the blocks carry padding instead of their own top rules. */
.dwa-preferences { border: var(--ntr-line); border-radius: var(--ntr-radius); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--ntr-shadow); overflow: hidden; }
.dwa-preference-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; }
.dwa-preference-row + .dwa-preference-row { border-top: var(--ntr-line-quiet); }
/* A control that needs the whole row: the label sits above it, not beside
   it. A right-aligned segmented control squeezed its labels into two lines
   each (中/止, 自动推/进), which read as broken rather than as choices. */
.dwa-preference-block { padding: 16px; }
.dwa-preference-block + .dwa-preference-block { border-top: var(--ntr-line-quiet); }
/* INLINE on purpose: the readout beside it is an inline pill, so a row's label
   and the row's own state share one line instead of stacking as two blocks. */
.dwa-preference-label { font-size: var(--ntr-font); font-weight: 600; display: inline; }
.dwa-preference-copy { margin-top: 2px; color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
.dwa-seg-wide { display: flex; width: 100%; margin-top: 10px; }
.dwa-seg-wide > button { flex: 1; }
/* The state of a bounded value (a slider rung, a hand-filled window): a pill
   beside the row's label, NOT a 20px headline. The label is the row's
   identity and the value is its current state, so they belong on one line —
   as a headline it outranked the section title above it. */
.dwa-deadline-value {
  display: inline-flex; align-items: center; margin: 0 0 0 8px; padding: 1px 9px;
  border-radius: 999px; background: var(--dsw-alias-state-business-tertiary, #dbeafe);
  color: var(--dsw-alias-state-business-primary, #2563eb);
  font-size: var(--ntr-font-sm); font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.6;
}
.dwa-deadline-range { width: 100%; margin-top: 10px; accent-color: var(--ntr-accent); }
.dwa-deadline-range:disabled { opacity: 0.4; }
/* Tick labels center on the exact rung fraction (inline left from tickLeft);
   space-between drifted them off the track when label widths differed. */
.dwa-deadline-ticks { position: relative; height: 1.5em; margin-top: 2px; color: var(--ntr-muted); font-size: 10px; }
.dwa-deadline-ticks > span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
.dwa-deadline-ticks > span:first-child { transform: none; }
.dwa-deadline-ticks > span:last-child { transform: translateX(-100%); }
/* The facts that make a number here meaningless, in warning ink rather than
   the muted gray every other hint uses: the value the config file is
   outranking, on the row it belongs to. */
.dwa-deadline-flag { margin-top: 4px; font-size: var(--ntr-font-xs); font-weight: 550; color: var(--ntr-warn); }
/* A standing fact a control cannot put in its own label (a rung that masks
   host tools, a mode that answers on your behalf): a tinted box. No rule on
   the left edge — that is decoration pretending to be hierarchy; the tint is
   the signal. Tones are host alias pairs (constraint 34). */
.dwa-deadline-warn { margin-top: 10px; padding: 9px 12px; border-radius: var(--ntr-radius-sm); background: var(--dsw-alias-state-warn-tertiary, #fffbeb); color: var(--ntr-warn); font-size: var(--ntr-font-xs); line-height: 1.55; }
.dwa-deadline-warn.is-neutral { background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-primary, #111827); }
.dwa-deadline-warn.is-success { background: var(--dsw-alias-state-success-tertiary, #dcfce7); color: var(--ntr-success); }
.dwa-deadline-warn.is-danger { background: var(--dsw-alias-interactive-bg-hover-danger, #fee2e2); color: var(--ntr-danger); }
.dwa-deadline-reset { display: flex; justify-content: flex-end; margin-top: 8px; }
/* A reset that closes a whole card's rows is a footer band, not a floating
   button: it gets the same divider and padding the rows above it have. */
.dwa-preferences > .dwa-deadline-reset { margin-top: 0; padding: 12px 16px; border-top: var(--ntr-line-quiet); }
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
/* ── The per-agent delegation config (「子智能体委派配置」) ────────────────────
 * One card per agent. The head is the summary line — name plus what this
 * agent's delegation profile actually overrides — and the whole band is the
 * fold button, so folding one agent never means hunting for a caret. The body
 * stays MOUNTED and is display-toggled: an in-progress description draft (a
 * local value committed on blur) must survive folding, exactly like the agent
 * roster cards above. */
.dwa-default-list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
/* The cards are .dwa-preference-block too, so the tests and the row grammar
 * still find one block per agent; the list overrides the row treatment (a row
 * is a band in a card, a card is its own boundary). */
.dwa-default-list > .dwa-preference-block {
  padding: 0; border: var(--ntr-line); border-radius: var(--ntr-radius);
  background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--ntr-shadow); overflow: hidden;
}
.dwa-acc-head { display: flex; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; }
.dwa-acc-toggle { flex: 1 1 0; min-width: 0; display: grid; grid-template-columns: 32px minmax(0, 1fr); align-items: center; gap: 12px; padding: 12px 0 12px 16px; border: 0; background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.dwa-acc-toggle:hover, .dwa-acc-caret:hover { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #f3f4f6) 55%, transparent); }
.dwa-acc-toggle:focus-visible { outline-offset: -2px; border-radius: var(--ntr-radius); }
.dwa-acc-head.is-disabled .dwa-acc-avatar, .dwa-acc-head.is-disabled .dwa-acc-name { opacity: 0.55; }
.dwa-acc-side { display: inline-flex; align-items: center; gap: 10px; flex: none; padding-right: 12px; }
.dwa-acc-divider { width: 1px; height: 18px; background: var(--dsw-alias-border-l3, #eef0f3); flex: none; }
.dwa-acc-caret { padding: 8px 4px; border-radius: var(--ntr-radius-sm); color: var(--ntr-muted); cursor: pointer; }
.dwa-acc-avatar { width: 32px; height: 32px; border-radius: var(--ntr-radius-sm); font-size: var(--ntr-font-xs); }
.dwa-acc-titles { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dwa-acc-name { font-size: var(--ntr-font); font-weight: 600; overflow-wrap: anywhere; }
.dwa-acc-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
/* What a delegation profile overrides, at a glance: the value is the fact, so
   a set axis reads in business ink and an unset one stays quiet gray. */
.dwa-sum-pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 7px; border-radius: 5px; font-size: var(--ntr-font-xs); line-height: 1.6; background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--ntr-muted); }
.dwa-sum-pill.is-set { background: var(--dsw-alias-state-business-tertiary, #dbeafe); color: var(--dsw-alias-state-business-primary, #2563eb); font-weight: 550; }
/* A profile that outranks the config file says so even while folded: the head
   is the only band a collapsed card shows, and constraint 33 does not allow an
   override fact to hide behind a click. */
.dwa-sum-pill.is-warn { background: var(--dsw-alias-state-warn-tertiary, #fef3c7); color: var(--ntr-warn); font-weight: 550; }
/* One step of surface, tinted: the head is the summary, the body is the form. */
.dwa-acc-body { padding: 14px 16px 16px; border-top: var(--ntr-line-quiet); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #f3f4f6) 42%, var(--dsw-alias-bg-layer-1, #fff)); }
.dwa-acc-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: var(--ntr-line-quiet); }
.dwa-acc-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--ntr-muted); font-size: var(--ntr-font-xs); }
/* The three axes are ONE decision, so they get one row of three equal
   columns. The old flex: 1 1 150px wrapped them into a lopsided 2+1 at the
   panel's usual width, and the odd one out stretched full width. */
.dwa-axis-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.dwa-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dwa-field-label { font-size: var(--ntr-font-xs); font-weight: 600; color: var(--dsw-alias-label-secondary, #4b5563); }
/* A short numeric input (minutes): the row says what it is, so the box does
   not need the full width the other inputs take. */
.dwa-input-short { max-width: 132px; }
/* ── The 技能 page ────────────────────────────────────────────────────────
 * The master switch is a card and the per-agent opt-outs are the card's own
 * continuation: one surface, rows inside it, no second heading. Not clipped
 * for the same reason the roster is not: each row carries a host Tooltip, and
 * a clipped card would cut the bubble off at the bottom edge. */
.dwa-skills-agents { margin-top: 12px; border: var(--ntr-line); border-radius: var(--ntr-radius); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--ntr-shadow); }
.dwa-skills-agents .dwa-preference-row { padding: 12px 16px; }
@media (max-width: 640px) {
  .dwa-root { padding: 20px 16px; }
}
@container (max-width: 640px) {
  .dwa-page-header { align-items: flex-start; flex-wrap: wrap; }
  /* The roster card owns its own padding now, so a stacked body must keep the
     card's inset instead of running to the edge. */
  .dwa-agent-body { padding-left: 16px; }
  .dwa-agent-row { grid-template-columns: 32px minmax(0, 1fr) auto; gap: 10px; }
  .dwa-agent-avatar { width: 32px; height: 32px; }
  .dwa-section-heading { flex-wrap: wrap; }
  .dwa-tabs { gap: 20px; }
  .dwa-notice { flex-wrap: wrap; }
  .dwa-seg-wide > button { padding-inline: 5px; }
  .dwa-model-toolbar-actions { width: 100%; }
  .dwa-model-search { flex: 1 1 auto; width: auto; }
  .dwa-preference-row { align-items: flex-start; flex-direction: column; }
  /* The 技能 rows are the one exception: a name and a 34px pill fit side by
     side at any width the panel realistically gets, and the pill never
     deforms, so a long agent name wraps on its own side instead of pushing the
     switch onto a second line. */
  .dwa-skills-agents .dwa-preference-row { flex-direction: row; align-items: center; }
  .dwa-default-hint { align-items: flex-start; flex-direction: column; }
  /* The three axes stack rather than shrink: three selects of ~90px each
     truncate every model name into noise. */
  .dwa-axis-grid { grid-template-columns: minmax(0, 1fr); }
  .dwa-row-split { flex-direction: column; align-items: stretch; }
  /* The split's halves are sized by its ROW axis (flex-basis 220px); once the
     split stacks, that basis becomes a HEIGHT and leaves a dead gap under a
     one-line label. */
  .dwa-row-split > .dwa-row-main { flex: none; }
  .dwa-row-side-select { flex: none; width: 100%; min-width: 0; }
  /* The slider's scale: up to eight rungs with full unit words ("15 分钟")
     need a smaller face before they can collide on a narrow panel. Labels
     sit at fixed rung fractions (tickLeft), so a shorter scale does not
     spread wider — the smaller face is what keeps neighbors apart. */
  .dwa-deadline-ticks { font-size: 9px; }
}
@media (prefers-reduced-motion: reduce) {
  .dwa-root *, .dwa-root *::before, .dwa-root *::after { transition: none !important; }
  .dwa-model-row:hover .dwa-model-row-value-text { animation: none !important; }
}

.dwa-mcp-card { display: flex; flex-direction: column; gap: 10px; box-shadow: var(--ntr-shadow); }
.dwa-mcp-card + .dwa-mcp-card { margin-top: 12px; }
.dwa-mcp-textarea { min-height: 112px; resize: vertical; }
.dwa-mcp-host-list { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: var(--ntr-line-quiet); }
.dwa-mcp-host-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--ntr-font-sm); }
.dwa-mcp-host-name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dwa-mcp-host-transport { font-size: var(--ntr-font-xs); color: var(--ntr-muted); }
.dwa-mcp-agents { margin-top: 20px; }
.dwa-mcp-agents .dwa-skills-agents { margin-top: 0; }
`

let styleMounted = false
export function ensureStyle(): void {
  if (styleMounted || typeof document === 'undefined') return
  styleMounted = true
  const node = document.createElement('style')
  node.textContent = STYLE
  document.head.appendChild(node)
}
