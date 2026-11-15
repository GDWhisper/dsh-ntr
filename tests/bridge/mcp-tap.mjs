/**
 * A `node --import` preload for `tests/mock-agent.mjs` that records the
 * `mcpServers` of every SESSION-CREATING request the agent receives:
 * `session/new` (registered sessions AND the config probe's throwaway one,
 * which no prompt can echo back), `session/load` and `session/fork`.
 *
 * The four entries are one acceptance surface because the agent keeps MCP
 * servers per PROCESS (AGENTS.md rule 32): a probe or a fork handing over a
 * different list would evict the tools of every live session on that
 * connection. Asserting that needs the ACTUAL wire list for all four, so this
 * taps the decoded stdin — one layer above the mock's handlers, hence
 * independent of what any handler happens to remember (and of the mock's
 * ratchet-locked size).
 *
 * With `MOCK_MCP_LOG=<path>` each request appends one line
 * `{"method":"session/new","mcpServers":[…]}`; without it this preload does
 * nothing, and frames are forwarded byte-for-byte either way.
 */
import { appendFileSync } from 'node:fs'
import { Readable } from 'node:stream'

const LOG = process.env.MOCK_MCP_LOG
const CREATING = new Set(['session/new', 'session/load', 'session/fork'])

let pending = ''

/** Record one complete NDJSON frame when it is a session-creating request. */
function recordLine(line) {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return // not a frame of ours: the stream still gets it untouched
  }
  if (typeof message?.method !== 'string' || !CREATING.has(message.method)) return
  appendFileSync(LOG, `${JSON.stringify({ method: message.method, mcpServers: message.params?.mcpServers ?? null })}\n`)
}

/** Frames can arrive split across chunks, so lines are reassembled. */
function recordChunk(chunk) {
  pending += Buffer.from(chunk).toString('utf8')
  for (;;) {
    const cut = pending.indexOf('\n')
    if (cut === -1) return
    const line = pending.slice(0, cut)
    pending = pending.slice(cut + 1)
    recordLine(line)
  }
}

if (LOG !== undefined) {
  const toWeb = Readable.toWeb
  // `Readable.toWeb` is what the mock turns `process.stdin` into; wrapping its
  // result is the only tap that sees every frame before the SDK decodes it.
  Readable.toWeb = function tapped(stream, options) {
    const tap = new TransformStream({
      transform(chunk, controller) {
        recordChunk(chunk)
        controller.enqueue(chunk)
      },
    })
    return toWeb.call(this, stream, options).pipeThrough(tap)
  }
}
