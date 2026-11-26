/**
 * Lightweight live tool-call index fed by `/api/acp/stream` `session/update`
 * frames so chat `AcpToolRow` cards show updated titles, arguments, live
 * output, and live diffs while a tool is running (`preparing` / `start`) and
 * retain enriched args/diffs on `result` when host `BlockAssembler` froze an
 * early `block-end` snapshot.
 */

import type { AcpLiveToolCall, AcpToolDiff, AcpToolLocation } from '../acp-tool-presentation.ts'
import { parseLocations } from '../acp-tool-presentation.ts'
import { parseToolContent } from './blocks.ts'

export const MAX_LIVE_TOOL_SESSIONS = 16
export const MAX_LIVE_TOOLS_PER_SESSION = 64

function rawToolNameOf(update: Record<string, unknown>): string | undefined {
  if (typeof update.name === 'string' && update.name !== '') return update.name
  const meta = update._meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (key.endsWith('toolName') && typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function rawInputOf(update: Record<string, unknown>): unknown {
  for (const key of ['rawInput', 'arguments'] as const) {
    const value = update[key]
    if (typeof value === 'string') {
      if (value === '') continue
      try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed === 'object' && parsed !== null) return parsed
      } catch {
        // Keep non-JSON plain strings verbatim.
      }
      return value
    }
    if (Array.isArray(value)) {
      if (value.length > 0) return value
      continue
    }
    if (typeof value === 'object' && value !== null) return value
  }
  return undefined
}

function sameLocations(a: readonly AcpToolLocation[] | undefined, b: readonly AcpToolLocation[] | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.path !== b[i]?.path || a[i]?.line !== b[i]?.line) return false
  }
  return true
}

function sameDiffs(a: readonly AcpToolDiff[] | undefined, b: readonly AcpToolDiff[] | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.path !== b[i]?.path || a[i]?.oldText !== b[i]?.oldText || a[i]?.newText !== b[i]?.newText) return false
  }
  return true
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function sameLiveToolCall(a: AcpLiveToolCall | undefined, b: AcpLiveToolCall): boolean {
  if (a === undefined) return false
  return a.title === b.title
    && a.kind === b.kind
    && a.tool === b.tool
    && a.outputText === b.outputText
    && sameLocations(a.locations, b.locations)
    && sameDiffs(a.diffs, b.diffs)
    && sameJsonValue(a.rawInput, b.rawInput)
}

export class LiveToolCallIndex {
  private readonly bySession = new Map<string, Map<string, AcpLiveToolCall>>()

  /** Fold a coalesced batch of `session/update` frames for one ACP session. */
  foldBatch(sessionId: string, items: ReadonlyArray<{ update: unknown }>): boolean {
    let changed = false
    for (const item of items) {
      const update = item.update as Record<string, unknown> | undefined
      if (update === undefined || typeof update !== 'object' || update === null) continue
      const kind = update.sessionUpdate
      if (kind !== 'tool_call' && kind !== 'tool_call_update') continue
      // Detached worker tool calls live in SubagentDetailService, never chat AcpToolRow cards.
      const meta = update._meta
      if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
        const parentId = (meta as Record<string, unknown>)['codebuddy.ai/parentToolCallId']
        if (typeof parentId === 'string' && parentId.trim() !== '') continue
      }
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId.trim() : ''
      if (callId === '') continue

      let sessionMap = this.bySession.get(sessionId)
      const prev = sessionMap?.get(callId)
      const parsed = parseToolContent(update.content)
      const outputParts = [...parsed.outputLines, ...parsed.extras].filter(s => s !== '')
      const incomingOutput = outputParts.length > 0 ? outputParts.join('\n') : undefined
      const incomingDiffs = parsed.diffs !== undefined && parsed.diffs.length > 0 ? parsed.diffs : undefined
      const incomingLocations = parseLocations(update.locations)
      const incomingRawInput = rawInputOf(update)
      const incomingTitle = typeof update.title === 'string' && update.title !== '' ? update.title : undefined
      const incomingKind = typeof update.kind === 'string' && update.kind.trim() !== '' ? update.kind.trim() : undefined
      const incomingTool = rawToolNameOf(update)

      const next: AcpLiveToolCall = {
        ...(incomingTitle !== undefined ? { title: incomingTitle } : prev?.title !== undefined ? { title: prev.title } : {}),
        ...(incomingKind !== undefined ? { kind: incomingKind } : prev?.kind !== undefined ? { kind: prev.kind } : {}),
        ...(incomingTool !== undefined ? { tool: incomingTool } : prev?.tool !== undefined ? { tool: prev.tool } : {}),
        ...(incomingLocations.length > 0 ? { locations: incomingLocations } : prev?.locations !== undefined ? { locations: prev.locations } : {}),
        ...(incomingRawInput !== undefined ? { rawInput: incomingRawInput } : prev?.rawInput !== undefined ? { rawInput: prev.rawInput } : {}),
        ...(incomingOutput !== undefined ? { outputText: incomingOutput } : prev?.outputText !== undefined ? { outputText: prev.outputText } : {}),
        ...(incomingDiffs !== undefined ? { diffs: incomingDiffs } : prev?.diffs !== undefined ? { diffs: prev.diffs } : {}),
      }

      if (sameLiveToolCall(prev, next)) continue

      if (sessionMap === undefined) {
        sessionMap = new Map()
        this.bySession.set(sessionId, sessionMap)
        while (this.bySession.size > MAX_LIVE_TOOL_SESSIONS) {
          const oldest = this.bySession.keys().next().value
          if (oldest === undefined) break
          this.bySession.delete(oldest)
        }
      } else {
        this.bySession.delete(sessionId)
        this.bySession.set(sessionId, sessionMap)
      }

      if (prev !== undefined) sessionMap.delete(callId)
      sessionMap.set(callId, next)
      while (sessionMap.size > MAX_LIVE_TOOLS_PER_SESSION) {
        const oldestCall = sessionMap.keys().next().value
        if (oldestCall === undefined) break
        sessionMap.delete(oldestCall)
      }
      changed = true
    }
    return changed
  }

  /** Drop buffered live tool calls when an ACP session resets, releases, or closes. */
  clearSession(sessionId: string): boolean {
    return this.bySession.delete(sessionId)
  }

  /**
   * Look up the latest live tool snapshot for `(dshSessionId, callId)`.
   * Scoped strictly by `owners` (`acpSessionId -> dshSessionId`) so identical
   * `toolCallId`s across conversations never leak into another chat.
   */
  get(dshSessionId: string | undefined, callId: string, owners: ReadonlyMap<string, string>): AcpLiveToolCall | undefined {
    if (callId === '' || dshSessionId === undefined || dshSessionId === '') return undefined
    let matched: AcpLiveToolCall | undefined
    for (const [acpSessionId, calls] of this.bySession) {
      if (owners.get(acpSessionId) !== dshSessionId) continue
      const candidate = calls.get(callId)
      if (candidate !== undefined) matched = candidate
    }
    return matched
  }
}
