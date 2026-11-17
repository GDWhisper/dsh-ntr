/**
 * ACP tool-call and message updates folded into the host tool-call stream: nothing dropped silently, diffs keep structure and text, oversize text truncated with a marker (constraint 29).
 *
 * Part of the `tests/impl.spec.ts` mirror: one file per `src/impl/` cluster,
 * same describe titles and case counts as before the split.
 */

import { describe, expect, it } from 'vitest'
import {
  acpToolCallArgsOf,
  acpToolCallDelta,
  acpToolCallFromUpdate,
  ACP_TOOL_CALL_NAME,
  describeUnhandledUpdate,
  updateContentToText,
  isAcpToolContinuation,
  isFinalToolCallStatus,
} from '../../src/impl.ts'

describe('ACP tool-call notifications → tool-call stream chunks', () => {
  it('folds an announcement into a snapshot: constant name, full title preserved in args', () => {
    // The name is a fixed plugin constant, NEVER the agent's own title; the
    // title lands in the args `description` so it is not silently dropped
    // (constraint 29) and the host preparing row can read it live.
    expect(acpToolCallFromUpdate({ toolCallId: ' c1 ', title: 'Bash', rawInput: '{"cmd":"ls"}' }))
      .toEqual({ callId: 'c1', name: ACP_TOOL_CALL_NAME, title: 'Bash', argsRaw: '{"description":"Bash","input":{"cmd":"ls"}}' })
    // A long command-string title survives IN FULL when the agent disclosed no
    // separate input: the exact case the constant-name fix must not lose.
    const command = "pwsh -NoProfile -Command Get-ChildItem -Recurse | Select-String 'SECRET_PATTERN_XYZ'"
    const snapshot = acpToolCallFromUpdate({ toolCallId: 'c1', title: command })!
    expect(snapshot.name).toBe(ACP_TOOL_CALL_NAME)
    expect(snapshot.title).toBe(command)
    expect((JSON.parse(snapshot.argsRaw) as { description: string }).description).toBe(command)
    // No id is not a tool call; no title and no input are legal ACP — an
    // honest empty card, not a fabricated placeholder. The empty name is also
    // what lets the bridge skip a bare status-only update as a phantom card.
    expect(acpToolCallFromUpdate({ title: 'no id' })).toBeUndefined()
    expect(acpToolCallFromUpdate({ toolCallId: 'c2' })).toEqual({ callId: 'c2', name: '', title: '', argsRaw: '' })
  })

  it('produces arguments the host preparing row can read: valid JSON with a leading description', () => {
    // Host contract (dsh-client-ui-tool `argumentSummary`, the `others` variant
    // an unknown tool name lands on): while a tool runs the preparing row shows
    // ONLY `args.text("description")` parsed from the argument JSON — the raw
    // body is gated behind `phase !== "preparing"`. The old `title\n{json}` text
    // was not valid JSON, so the host read no field and the row fell back to the
    // bare tool name: the operation stayed invisible until the tool finished.
    const snapshot = acpToolCallFromUpdate({ toolCallId: 'c1', title: 'Bash', rawInput: { command: 'ls -la' } })!
    const parsed = JSON.parse(snapshot.argsRaw) as Record<string, unknown>
    expect(parsed.description).toBe('Bash')
    // description must be the FIRST key so the lazy JSON scanner reads it early.
    expect(Object.keys(parsed)[0]).toBe('description')
    // The disclosed input survives verbatim under `input` (constraint 29).
    expect(parsed.input).toEqual({ command: 'ls -la' })
    // A title-less call still surfaces the operation from its own input.
    const noTitle = acpToolCallFromUpdate({ toolCallId: 'c2', rawInput: { command: 'git status' } })!
    expect((JSON.parse(noTitle.argsRaw) as Record<string, unknown>).description).toBe('git status')
  })

  it('reads only the two live statuses as "output may still arrive"', () => {
    expect(isFinalToolCallStatus('pending')).toBe(false)
    expect(isFinalToolCallStatus('in_progress')).toBe(false)
    // The announcing `tool_call` routinely carries no status at all: treating
    // that as terminal would answer a display card before the tool ran.
    expect(isFinalToolCallStatus(undefined)).toBe(false)
    expect(isFinalToolCallStatus('')).toBe(false)
    expect(isFinalToolCallStatus(3)).toBe(false)
    expect(isFinalToolCallStatus('completed')).toBe(true)
    expect(isFinalToolCallStatus('failed')).toBe(true)
    // ACP v2 adds `cancelled`, and an agent may invent its own: anything not
    // live is terminal.
    expect(isFinalToolCallStatus('cancelled')).toBe(true)
  })

  it('reads the input spellings agents use in the wild, and nothing when they send none', () => {
    expect(acpToolCallArgsOf({ rawInput: '{"a":1}' })).toBe('{"a":1}')
    expect(acpToolCallArgsOf({ arguments: 'plain' })).toBe('plain')
    expect(acpToolCallArgsOf({ arguments: { a: 1 } })).toBe('{"a":1}')
    // An array (batched input) is an argument spelling too, not an empty one.
    expect(acpToolCallArgsOf({ arguments: [{ a: 1 }] })).toBe('[{"a":1}]')
    // An unserializable value degrades to text rather than failing the turn.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(acpToolCallArgsOf({ arguments: circular })).toBe('[object Object]')
    // No input at all is legal ACP: `''`, not a fabricated placeholder.
    expect(acpToolCallArgsOf({ toolCallId: 'c' })).toBe('')
  })

  it('moves the snapshot on a restatement; the closing block carries the whole JSON payload', () => {
    // The accumulator CONCATENATES `argumentsDelta`, while ACP restates the
    // whole input. The args are a JSON object (`description` + `input`), so a
    // restatement that fills in the input is a replacement, not a prefix
    // extension: no honest delta exists, the snapshot moves, and the closing
    // `block-end` replaces the block wholesale. The operation label stays in
    // `description` throughout, so the preparing row reads it from the first frame.
    const snapshot = acpToolCallFromUpdate({ toolCallId: 't1', title: 'first tool', rawInput: '{"cmd":"' })!
    expect(acpToolCallDelta(snapshot, { toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' })).toEqual([])
    expect(snapshot.argsRaw).toBe('{"description":"first tool","input":{"cmd":"ls -la"}}')
    // A rewrite (not an extension) likewise moves the snapshot for the close.
    const second = acpToolCallFromUpdate({ toolCallId: 't1', rawInput: '{"cmd":""}' })!
    expect(acpToolCallDelta(second, { toolCallId: 't1', rawInput: '{"cmd":"ls -la"}' })).toEqual([])
    expect(second.argsRaw).toBe('{"description":"ls -la","input":{"cmd":"ls -la"}}')
  })

  it('never emits a raw title as a name delta; the constant name stays and the rewritten command is preserved', () => {
    // codebuddy rewrites titles mid-call: a name delta would re-inject a long
    // command as the (host) tool name. The name is a fixed constant, so NO name
    // delta is emitted; the NEW title is preserved in argsRaw instead.
    const snapshot = acpToolCallFromUpdate({ toolCallId: 't1', title: 'pwsh -Command Get-Process' })!
    expect(snapshot.name).toBe(ACP_TOOL_CALL_NAME)
    const rewritten = 'pwsh -Command Get-Process | Where-Object { $_.CPU -gt 100 } | Format-Table -AutoSize'
    const deltas = acpToolCallDelta(snapshot, { toolCallId: 't1', title: rewritten })
    expect(deltas.every(delta => delta.kind !== 'name')).toBe(true)
    expect(snapshot.name).toBe(ACP_TOOL_CALL_NAME)
    expect(snapshot.title).toBe(rewritten)
    expect((JSON.parse(snapshot.argsRaw) as { description: string }).description).toBe(rewritten)
    // A title-less update keeps the already-preserved title (no silent drop).
    const after = acpToolCallDelta(snapshot, { toolCallId: 't1', rawInput: '{"cmd":"ls"}' })
    expect(after.every(delta => delta.kind !== 'name')).toBe(true)
    expect(snapshot.argsRaw).toContain(rewritten)
    expect(snapshot.argsRaw).toContain('{"cmd":"ls"}')
  })

  it('promotes an empty snapshot name to ACP_TOOL_CALL_NAME and emits a name delta on update with title or args or content', () => {
    // A tool call announced with only an id starts with an empty name
    // (the phantom-card guard convention). When an update supplies a title
    // or input, the name must be promoted to the constant and emit a name
    // delta so the host knows the card's tool name.
    const snapshot = acpToolCallFromUpdate({ toolCallId: 'c2' })!
    expect(snapshot.name).toBe('')
    const deltas = acpToolCallDelta(snapshot, { toolCallId: 'c2', title: 'Bash', rawInput: 'ls' })
    expect(snapshot.name).toBe(ACP_TOOL_CALL_NAME)
    expect(deltas).toContainEqual({ kind: 'name', name: ACP_TOOL_CALL_NAME })
    expect(deltas).toContainEqual({ kind: 'args', text: '{"description":"Bash","input":"ls"}' })

    // Subsequent updates do NOT re-emit the name delta
    const after = acpToolCallDelta(snapshot, { toolCallId: 'c2', rawInput: 'ls -la' })
    expect(after.every(d => d.kind !== 'name')).toBe(true)

    // A call that starts empty and gets content also promotes its name
    const contentSnap = acpToolCallFromUpdate({ toolCallId: 'c3' })!
    expect(contentSnap.name).toBe('')
    const contentDeltas = acpToolCallDelta(contentSnap, {
      toolCallId: 'c3',
      content: [{ type: 'content', content: { type: 'text', text: 'output' } }],
    })
    expect(contentSnap.name).toBe(ACP_TOOL_CALL_NAME)
    expect(contentDeltas).toContainEqual({ kind: 'name', name: ACP_TOOL_CALL_NAME })
    expect(contentDeltas).toContainEqual({ kind: 'args', text: '{"description":"output"}' })
  })

  it('recognizes the continuation steps of a card-bearing turn, and only those', () => {
    // Tool-sourced messages AFTER the last user one: the staged results the
    // host loop feeds a card-bearing turn's next step with.
    expect(isAcpToolContinuation([
      { role: 'user', source: { kind: 'user' } },
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
    ])).toBe(true)
    // The person's new words are the last message: a fresh prompt.
    expect(isAcpToolContinuation([
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
      { role: 'user', source: { kind: 'user' } },
    ])).toBe(false)
    // History from earlier turns sits BEFORE the new user text.
    expect(isAcpToolContinuation([
      { role: 'tool', source: { kind: 'tool', callId: 'c0' } },
      { role: 'user', source: { kind: 'user' } },
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
    ])).toBe(true)
    // A source-less message counts as user input (the hand-built convention).
    expect(isAcpToolContinuation([
      { role: 'tool', source: { kind: 'tool', callId: 'c1' } },
      { role: 'user' },
    ])).toBe(false)
    expect(isAcpToolContinuation([{ role: 'user', source: { kind: 'user' } }])).toBe(false)
    expect(isAcpToolContinuation([])).toBe(false)
  })

  it('keeps the content kinds the Chat plane cannot render, instead of placeholders', () => {
    const text = updateContentToText([
      { type: 'content', content: { type: 'text', text: 'first' } },
      { type: 'diff', path: '/w/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
      { type: 'content', content: { type: 'image', data: 'abc' } },
      { type: 'terminal', terminalId: 't1' },
    ])
    expect(text).toContain('first')
    // A diff becomes its path plus -/+ lines, not a `[diff path]` stub.
    expect(text).toContain('/w/a.ts')
    expect(text).toContain('- two')
    expect(text).toContain('+ TWO')
    // Unknown kinds keep their whole payload.
    expect(text).toContain('"data":"abc"')
    expect(text).toContain('"terminalId":"t1"')
  })

  it('describes a notification it has no card for without dropping its payload', () => {
    expect(describeUnhandledUpdate('plan', {
      entries: [{ content: 'fix the bug', status: 'in_progress', priority: 'high' }],
    })).toBe('[in_progress] [high] fix the bug')
    expect(describeUnhandledUpdate('current_mode_update', { currentModeId: 'plan' })).toBe('current_mode_update: plan')
    expect(describeUnhandledUpdate('brand_new_kind', { sessionUpdate: 'brand_new_kind', extra: [1, 2] }))
      .toContain('"extra": [')
  })
})
