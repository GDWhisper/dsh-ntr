/** ACP `usage_update` is context occupancy, not request tokens; prose burst estimates weight CJK denser than ASCII (tool args excluded). */
export const OUTPUT_CHARS_PER_TOKEN = 4
export const CJK_CHARS_PER_TOKEN = 1.5
export const BURST_GAP_MS = 1000
/** Minimum measured burst duration (ms) required before publishing or persisting a rate, avoiding batched-flush spikes. */
export const MIN_BURST_MS = 50

export interface TurnTpsSnapshot {
  outputTokens: number
  burstMs: number
}

function isCjkCodeUnit(code: number): boolean {
  return (code >= 0x3000 && code <= 0x30ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)
}

export function estimateProseTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) {
    if (isCjkCodeUnit(text.charCodeAt(i))) cjk += 1
  }
  const other = text.length - cjk
  return Math.round(cjk / CJK_CHARS_PER_TOKEN + other / OUTPUT_CHARS_PER_TOKEN)
}

export class TurnTpsTracker {
  private readonly gapMs: number
  private lastProseAt: number | undefined
  private cjkChars = 0
  private otherChars = 0
  private burstMs = 0

  constructor(gapMs = BURST_GAP_MS) {
    this.gapMs = gapMs
  }

  onProse(text: string, at: number): void {
    if (text === '') return
    if (this.lastProseAt === undefined) {
      // First chunk after turn start or break anchors the burst clock without crediting untimed tokens.
      this.lastProseAt = at
      return
    }
    const gap = at - this.lastProseAt
    this.lastProseAt = at
    if (gap < 0 || gap > this.gapMs) return
    this.burstMs += gap
    for (let i = 0; i < text.length; i += 1) {
      if (isCjkCodeUnit(text.charCodeAt(i))) this.cjkChars += 1
      else this.otherChars += 1
    }
  }

  onBreak(): void {
    this.lastProseAt = undefined
  }

  snapshot(): TurnTpsSnapshot {
    return {
      outputTokens: Math.round(this.cjkChars / CJK_CHARS_PER_TOKEN + this.otherChars / OUTPUT_CHARS_PER_TOKEN),
      burstMs: this.burstMs,
    }
  }
}
