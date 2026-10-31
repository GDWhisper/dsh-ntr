/** ACP `usage_update` is context occupancy, not request tokens; this is the plugin's 4-chars/token OUTPUT estimate (tool args excluded). */
export const OUTPUT_CHARS_PER_TOKEN = 4
export const BURST_GAP_MS = 1000

export interface TurnTpsSnapshot {
  outputTokens: number
  burstMs: number
}

export class TurnTpsTracker {
  private readonly gapMs: number
  private lastProseAt: number | undefined
  private outputChars = 0
  private burstMs = 0

  constructor(gapMs = BURST_GAP_MS) {
    this.gapMs = gapMs
  }

  onProse(text: string, at: number): void {
    if (text === '') return
    if (this.lastProseAt !== undefined) {
      const gap = at - this.lastProseAt
      if (gap <= this.gapMs) this.burstMs += gap
    }
    this.lastProseAt = at
    this.outputChars += text.length
  }

  onBreak(): void {
    this.lastProseAt = undefined
  }

  snapshot(): TurnTpsSnapshot {
    return {
      outputTokens: Math.round(this.outputChars / OUTPUT_CHARS_PER_TOKEN),
      burstMs: this.burstMs,
    }
  }
}
