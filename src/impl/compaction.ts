/**
 * Pure ACP context-compaction helpers (`session.compaction` capability,
 * `compaction_update` / `compaction_summary_chunk` formatting, and `/compact`
 * silent-turn detection). No Node imports, no SDK runtime imports.
 */

const COMPACT_COMMAND_RE = /^\/compact(?:\s|$)/i

/** Whether a user prompt invokes `/compact` (or `/compact <args>`). */
export function isCompactCommand(promptText: string): boolean {
  const trimmed = promptText.trim()
  if (trimmed === '') return false
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return COMPACT_COMMAND_RE.test(firstLine)
}

/** Readable text extracted from a `ContentBlock` or `ContentBlock[]` compaction payload. */
export function compactionContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      const text = compactionContentText(item)
      if (text !== '') parts.push(text)
    }
    return parts.join('\n')
  }
  if (typeof content === 'object' && content !== null) {
    const row = content as Record<string, unknown>
    if (typeof row.text === 'string') return row.text
    if (row.type === 'content' && row.content !== undefined) return compactionContentText(row.content)
  }
  return ''
}

/**
 * Format one `compaction_update` or `compaction_summary_chunk` notification for
 * the host chat stream. Returns `undefined` when nothing new needs emitting
 * (e.g., repeated `in_progress` ticks for the same `compactionId`).
 */
export function formatCompactionNotification(
  update: Record<string, unknown>,
  statuses: Map<string, string>,
): string | undefined {
  const kind = String(update.sessionUpdate ?? '')
  const compactionId = typeof update.compactionId === 'string' ? update.compactionId : ''
  if (kind === 'compaction_summary_chunk') {
    const text = compactionContentText(update.content)
    return text === '' ? undefined : text
  }
  if (kind !== 'compaction_update') return undefined
  const status = typeof update.status === 'string' && update.status !== '' ? update.status : 'unknown'
  const summary = compactionContentText(update.summary)
  const error = typeof update.error === 'string' ? update.error.trim() : ''
  const prevStatus = compactionId === '' ? undefined : statuses.get(compactionId)
  if (compactionId !== '') statuses.set(compactionId, status)

  if (status === 'in_progress') {
    if (prevStatus === 'in_progress') return undefined
    return '[dsh-ntr] context compaction in progress…'
  }
  if (status === 'completed') {
    if (summary !== '') return `[dsh-ntr] context compaction completed.\n\n${summary}`
    if (prevStatus === 'completed') return undefined
    return '[dsh-ntr] context compaction completed.'
  }
  if (status === 'failed') {
    return error !== ''
      ? `[dsh-ntr] context compaction failed: ${error}`
      : '[dsh-ntr] context compaction failed.'
  }
  if (status === 'cancelled') {
    if (prevStatus === 'cancelled') return undefined
    return '[dsh-ntr] context compaction cancelled.'
  }
  const detail = summary !== '' ? `: ${summary}` : error !== '' ? `: ${error}` : '.'
  return `[dsh-ntr] context compaction (${status})${detail}`
}

/** Completion line when `/compact` ends normally with no visible output from the agent. */
export function compactCompletionLine(agentId: string, stopReason?: string): string {
  const reason = stopReason !== undefined && stopReason !== 'end_turn' ? ` (${stopReason})` : ''
  return `\n[dsh-ntr] agent "${agentId}" completed context compaction${reason}.\n`
}
