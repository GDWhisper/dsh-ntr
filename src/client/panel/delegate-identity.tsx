/**
 * The delegation IDENTITY: one short classification tag per agent, plus the
 * preset table that seeds it. It lives beside the description because the two
 * are one fact at two resolutions — the tag is what the caller can compare
 * ACROSS rows without parsing prose, the description is the detail behind it.
 *
 * Why a tag at all: the roster row is the ONLY place the caller learns who an
 * agent is (it picks before any process exists), and a blank description used
 * to leave rows differing only by id. A tag guarantees every row carries a
 * comparable classification from day one.
 *
 * The tag is descriptive ONLY. It never joins the axis value chain (explicit
 * arg > persisted default > the agent process's own default) and the runtime
 * never reads it, so renaming a tag cannot change how a run executes.
 *
 * Seeding rule (the user's call): picking a preset FILLS the description when
 * there is nothing to destroy — blank, or still the previous preset's own text
 * — and asks first when the user has written something. The dialog shows both
 * texts and offers keep / replace, so a switch between presets is one click
 * while a real edit is never lost silently.
 */
import { useState } from 'react'
import { DELEGATE_IDENTITY_MAX } from '../../protocol.ts'
import type { AcpStore } from '../store.ts'

/** One shipped preset: the tag plus the description it seeds. */
export interface DelegateIdentityPreset {
  identity: string
  description: string
}

/**
 * The presets the plugin ships. The taxonomy mirrors the tool description's
 * own task list (research / single-file edits / review passes), so a tag the
 * caller already has words for. Deliberately NOT in `src/bridge/state-paths.ts`
 * beside `AGENT_PRESETS`: only the browser renders them, so a third
 * hand-copied table (constraint 7's known pain) would buy nothing.
 *
 * English on purpose: the roster row is model-facing copy, and the row is one
 * language end to end (see AGENTS/ui-panel.md §8's language rule).
 */
export const DELEGATE_IDENTITY_PRESETS: readonly DelegateIdentityPreset[] = [
  {
    identity: 'general-purpose',
    description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.',
  },
  {
    identity: 'code-reviewer',
    description: 'Reviews new or modified code for logic bugs, edge cases, security risks, performance issues, and convention deviations, providing severity-ordered feedback. Ideal for pre-commit checks, PR reviews, and refactoring assessments. Accepts diffs, file paths, or code snippets.',
  },
  {
    identity: 'Research',
    description: 'Read-only research and second opinions: reads code and docs, returns conclusions and tradeoffs, changes no files.',
  },
]

/** The preset a value names, or undefined for a custom tag / no tag. */
export function identityPresetFor(identity: string | undefined): DelegateIdentityPreset | undefined {
  if (identity === undefined || identity === '') return undefined
  return DELEGATE_IDENTITY_PRESETS.find(preset => preset.identity === identity)
}

/**
 * What picking `nextIdentity` should do to the description. `fill` = seed it
 * silently, `confirm` = ask first, `none` = leave the description alone.
 *
 * `none` covers the two cases where there is nothing to seed and nothing to
 * destroy: a custom tag (no preset text exists) and a preset whose own text is
 * empty. Clearing the tag never reaches this function at all.
 *
 * `fill` covers "nothing to destroy": a blank description, and a description
 * that is still the CURRENT identity's preset text — swapping one preset for
 * another is not losing user work, so it must not cost a dialog.
 *
 * One deliberate side effect: re-picking the identity a row ALREADY has, while
 * its description is the user's own text, also asks — which doubles as an
 * explicit "reset the description to this preset" path. That is a feature, not
 * an accident: the alternative (silently doing nothing) would make the second
 * pick look broken.
 */
export function identityFillDecision(
  nextIdentity: string,
  currentIdentity: string | undefined,
  description: string | undefined,
): 'none' | 'fill' | 'confirm' {
  const preset = identityPresetFor(nextIdentity)
  if (preset === undefined || preset.description === '') return 'none'
  const current = description?.trim() ?? ''
  if (current === '') return 'fill'
  const currentPreset = identityPresetFor(currentIdentity)
  if (currentPreset !== undefined && currentPreset.description === current) return 'fill'
  return 'confirm'
}

/** The sentinel a non-preset value selects; it renders the value itself. */
const CUSTOM_OPTION = '\u0000custom'

/**
 * The identity control: a preset dropdown that doubles as a free-text tag.
 *
 * The `<select>` mirrors `AxisSelect`'s kept-value idiom — a persisted value no
 * preset names stays selectable and spells itself, rather than being hidden
 * behind a "custom" label the user cannot read back. 「自定义…」 opens the text
 * input, which commits on blur / Enter and treats an empty commit as "keep
 * what I had" (clearing goes through the explicit 未设置 option, so an
 * accidental blur can never unset a tag).
 */
export function IdentityField(props: {
  acp: AcpStore
  title: string
  identity: string | undefined
  /** The description's LIVE text (the input's draft), not only the saved one. */
  description: string
  /** Write the identity alone; the description is left untouched. */
  onIdentity: (identity: string | undefined) => void
  /** Write the identity together with the preset's description. */
  onIdentityWithDescription: (identity: string, description: string) => void
}) {
  const { acp, title, identity, description, onIdentity, onIdentityWithDescription } = props
  const [custom, setCustom] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<DelegateIdentityPreset | undefined>(undefined)
  const label = acp.label('身份', 'Identity')

  // ONE entry point, and it resets every transient state it can make stale:
  // leaving the custom input open (its draft would commit on a later blur and
  // silently revert the pick just made) or an older dialog open (its buttons
  // would write back an identity the user has already changed or cleared).
  const pick = (raw: string): void => {
    setCustom(false)
    setPending(undefined)
    if (raw === '') {
      onIdentity(undefined)
      return
    }
    if (raw === CUSTOM_OPTION) {
      setDraft(identity ?? '')
      setCustom(true)
      return
    }
    const preset = identityPresetFor(raw)
    if (preset === undefined) return
    const decision = identityFillDecision(preset.identity, identity, description)
    if (decision === 'fill') onIdentityWithDescription(preset.identity, preset.description)
    else if (decision === 'confirm') setPending(preset)
    else onIdentity(preset.identity)
  }

  const commitCustom = (): void => {
    const trimmed = draft.trim()
    setCustom(false)
    if (trimmed === '' || trimmed === identity) return
    onIdentity(trimmed)
  }

  return (
    <div className="dwa-field" style={{ marginTop: 12 }}>
      <span className="dwa-field-label">{label}</span>
      <select
        className="dwa-select"
        aria-label={`${label} · ${title}`}
        value={identity === undefined ? '' : identityPresetFor(identity) === undefined ? CUSTOM_OPTION : identity}
        onChange={event => pick(event.target.value)}
      >
        {identity === undefined
          // Nothing set yet: the placeholder MATCHES the select's own value, so
          // the control shows text instead of an empty box (a select with no
          // matching option renders blank and looks broken). It is disabled —
          // a placeholder is not a choice, and clearing stays impossible until
          // something is actually set.
          ? <option value="" disabled>{acp.label('未设置身份…', 'No identity…')}</option>
          : <option value="">{acp.label('未设置', 'Not set')}</option>}
        {DELEGATE_IDENTITY_PRESETS.map(preset => (
          <option key={preset.identity} value={preset.identity}>{preset.identity}</option>
        ))}
        <option value={CUSTOM_OPTION}>
          {identity !== undefined && identityPresetFor(identity) === undefined ? identity : acp.label('自定义身份…', 'Custom identity…')}
        </option>
      </select>
      {custom && (
        <input
          className="dwa-input"
          aria-label={`${label}（自定义） · ${title}`}
          maxLength={DELEGATE_IDENTITY_MAX}
          placeholder={acp.label('给这个 agent 一个简短分类', 'A short classification for this agent')}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onBlur={commitCustom}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitCustom()
            }
          }}
        />
      )}
      <div className="dwa-preference-copy">
        {acp.label(
          '选预设身份会一并填入下方描述；描述已被改过时会先问你，不会静默覆盖。',
          'A preset identity also seeds the description below, and asks first when you already wrote one — never a silent overwrite.',
        )}
      </div>
      {pending !== undefined && (
        <IdentitySwapDialog
          acp={acp}
          title={title}
          preset={pending}
          current={description ?? ''}
          onKeep={() => {
            const chosen = pending.identity
            setPending(undefined)
            onIdentity(chosen)
          }}
          onReplace={() => {
            const chosen = pending
            setPending(undefined)
            onIdentityWithDescription(chosen.identity, chosen.description)
          }}
        />
      )}
    </div>
  )
}

/**
 * The keep-or-replace question, inline like `agent-details.tsx`'s save confirm:
 * the panel has no modal precedent, and `shell.overlay` (where the real dialog
 * layer lives) is not reachable from this section. Both texts are shown — the
 * one that would be lost and the one that would replace it — because "replace
 * with something" is not a question anyone can answer blind.
 *
 * The current text is the description's LIVE draft, so an edit the user has
 * typed but not yet blurred is what gets quoted (and what a replace would
 * lose) — never a value the user cannot see on screen.
 *
 * Escape keeps the description, which is also the safe default the primary
 * button carries; focus lands on it so a keyboard user is inside the question
 * rather than still on the dropdown that opened it.
 */
function IdentitySwapDialog(props: {
  acp: AcpStore
  title: string
  preset: DelegateIdentityPreset
  current: string
  onKeep: () => void
  onReplace: () => void
}) {
  const { acp, title, preset, current, onKeep, onReplace } = props
  return (
    <div
      className="dwa-card dwa-card-warn dwa-save-confirm"
      role="alertdialog"
      aria-label={acp.label('替换描述', 'Replace description')}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onKeep()
        }
      }}
    >
      <div>
        {acp.label(
          `这个 agent 已有描述。选用预设身份「${preset.identity}」会把它替换为：`,
          `This agent already has a description. Picking the preset identity "${preset.identity}" replaces it with:`,
        )}
      </div>
      <div className="dwa-hint dwa-mono dwa-identity-swap-text">{preset.description}</div>
      <div className="dwa-hint">
        {acp.label('当前的描述：', 'The description today:')}
        <span className="dwa-mono dwa-identity-swap-text">{current.trim() === '' ? acp.label('（空）', '(empty)') : current}</span>
      </div>
      <div className="dwa-save-confirm-actions">
        <button type="button" className="dwa-btn dwa-btn-quiet" onClick={onKeep}>
          {acp.label('不替换', 'Keep mine')}
        </button>
        <button type="button" className="dwa-btn" onClick={onReplace}>
          {acp.label('替换', 'Replace')}
        </button>
      </div>
    </div>
  )
}
