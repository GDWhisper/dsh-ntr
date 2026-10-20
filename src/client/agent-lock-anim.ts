/**
 * The one-shot hand-off from the composer's agent base to the edge tag.
 *
 * The base and the tag live in DIFFERENT slots (`conversation.input.model` and
 * `conversation.input.overlay`), so neither can animate the other directly.
 * This module is the shared clock they both read: when the conversation locks
 * to its agent, the base plays a shatter for {@link SHATTER_MS} while the tag
 * stays hidden, then the tag mounts and condenses for {@link FORM_MS}. Both
 * surfaces derive the same phase from the same map, so the two slots cannot
 * drift apart.
 *
 * The ceremony plays at the START of the conversation's first turn: the host
 * locks (and broadcasts) it as soon as the first ACP session is ready, before
 * the prompt is sent. If that turn delivers nothing at all, the host rolls the
 * lock back (`chat/agent-unlocked`); the base returns and the tag disappears,
 * with no reverse ceremony — the important part there is that the picker is
 * usable again.
 *
 * It must NOT replay on a page load. The lock is durable, so opening a
 * conversation that locked yesterday would otherwise replay the ceremony every
 * time. `AgentLockPhase` is therefore parameterized by the store's
 * `agentLockReveal` serial, which only advances when THIS page witnesses a
 * conversation go from unlocked to locked (a `chat/agent-locked` frame, or a
 * later `session/chat-list` answer). A reveal with no animation entry yet reads
 * as `shatter` (the commit that first sees it renders the base with its shatter
 * class immediately — no frame without either surface), and once the clock
 * finishes it records that serial as consumed so the phase settles to `idle`.
 * A NEWER reveal (a retry after a rolled-back first turn) restarts the clock
 * even if the previous ceremony is still running; the old timers are fenced off
 * by their epoch.
 *
 * `prefers-reduced-motion` turns the whole ceremony off: the base disappears
 * and the tag appears in the same commit.
 */

import { useSyncExternalStore } from 'react'

export type AgentLockPhase = 'idle' | 'shatter' | 'form'

interface ActiveAnim {
  phase: 'shatter' | 'form'
  reveal: number
  /** Fences timers of a ceremony a newer reveal replaced. */
  epoch: number
}

/** Keep in step with the `ntr-acp-shatter-chip` / `ntr-acp-shard-out` CSS. */
export const SHATTER_MS = 460
/** Keep in step with the `ntr-acp-form-chip` / `ntr-acp-shard-in` CSS. */
export const FORM_MS = 540

const phases = new Map<string, ActiveAnim>()
/** The reveal serial whose ceremony has already played (or was skipped). */
const consumed = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0
let epochSeq = 0

function emit(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The phase for one conversation. `reveal` is the store's lock-reveal serial
 * for it (absent for a conversation this page never saw lock). A brand-new,
 * not-yet-consumed reveal reads as `shatter` so the commit after the lock
 * already renders the shattering base rather than briefly rendering neither
 * surface. An active ceremony only answers for its OWN reveal: a retry after a
 * rolled-back first turn is a new reveal and must start from `shatter`.
 */
export function agentLockPhaseOf(sessionId: string, reveal?: number): AgentLockPhase {
  const active = phases.get(sessionId)
  if (active !== undefined && active.reveal === reveal) return active.phase
  if (reveal === undefined || consumed.get(sessionId) === reveal || reducedMotion()) return 'idle'
  return 'shatter'
}

/**
 * Start the ceremony for a reveal this page witnessed. Idempotent for the same
 * reveal (both slots call it from an effect); a newer reveal supersedes a
 * running older one, whose timers are fenced by the epoch check.
 */
export function playAgentLockAnim(sessionId: string, reveal: number): void {
  const active = phases.get(sessionId)
  if (active?.reveal === reveal || consumed.get(sessionId) === reveal) return
  if (reducedMotion()) {
    phases.delete(sessionId)
    consumed.set(sessionId, reveal)
    emit()
    return
  }
  const epoch = ++epochSeq
  phases.set(sessionId, { phase: 'shatter', reveal, epoch })
  emit()
  setTimeout(() => {
    const current = phases.get(sessionId)
    if (current === undefined || current.epoch !== epoch || current.phase !== 'shatter') return
    phases.set(sessionId, { ...current, phase: 'form' })
    emit()
    setTimeout(() => {
      const done = phases.get(sessionId)
      if (done === undefined || done.epoch !== epoch || done.phase !== 'form') return
      phases.delete(sessionId)
      consumed.set(sessionId, reveal)
      emit()
    }, FORM_MS)
  }, SHATTER_MS)
}

/** Subscribe to phase changes (one global clock shared by both slots). */
export function useAgentLockPhase(sessionId: string, reveal?: number): AgentLockPhase {
  useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    () => version,
  )
  return agentLockPhaseOf(sessionId, reveal)
}
