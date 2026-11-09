/**
 * Error text for user-facing notices. Kept beside the manager (and its
 * subagent service) because both halves compose the same sentences.
 *
 * JSON-RPC errors often carry the actionable detail in `data` (e.g. pi-acp
 * reports `{ errorKind: 'billing_error', message: '…' }` while `message` is the
 * generic "Internal error"). Surface both.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const data = (error as { data?: { errorKind?: unknown; message?: unknown } }).data
    const kind = typeof data?.errorKind === 'string' ? data.errorKind : undefined
    const detail = typeof data?.message === 'string' ? data.message : undefined
    const tail = [kind, detail].filter((v): v is string => v !== undefined && v !== '').join(': ')
    return tail === '' ? error.message : `${error.message} — ${tail}`
  }
  return String(error)
}
