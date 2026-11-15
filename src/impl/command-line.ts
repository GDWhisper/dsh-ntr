/**
 * Command-line tokenizing and quoting.
 *
 * `AcpAgentDef.command` is a COMMAND LINE, not a bare program, so the host splits and re-quotes it itself.
 *
 * Part of the host-half logic; the barrel is `src/impl.ts` and every existing
 * `../impl.ts` import keeps resolving through it. Pure logic only — no Node
 * APIs, no ACP SDK runtime values.
 */

// ---- Command lines (`AcpAgentDef.command` is a command LINE, not a bare program) ----

/**
 * Split a command line into tokens, the way a shell would: whitespace
 * separates, single or double quotes group.
 *
 * Inside double quotes a backslash escapes a quote (`\"`) and is otherwise
 * LITERAL — Windows paths are full of backslashes, so treating `\` as a general
 * escape would mangle `"C:\Program Files\agent.exe"`. Best-effort only: an
 * unbalanced quote swallows the rest of the line, which is the same thing a
 * shell does and is reported by the caller as a missing executable.
 */
export function tokenizeCommandLine(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let touched = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string
    if (quote !== undefined) {
      if (char === '\\' && quote === '"' && raw[index + 1] === '"') {
        current += '"'
        index += 1
        continue
      }
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      touched = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      // `touched` keeps an explicitly empty quoted argument (`""`) alive.
      if (touched || current !== '') tokens.push(current)
      current = ''
      touched = false
      continue
    }
    current += char
    touched = true
  }
  if (touched || current !== '') tokens.push(current)
  return tokens
}

/** First token = program, rest = arguments (see {@link tokenizeCommandLine}). */
export function splitCommandLine(raw: string): { command: string; args: string[] } {
  const tokens = tokenizeCommandLine(raw)
  return { command: tokens[0] ?? '', args: tokens.slice(1) }
}

/** Quote one token for a command line — only when it needs it. Inverse of the tokenizer. */
export function quoteCommandToken(token: string): string {
  if (token !== '' && !/[\s"']/.test(token)) return token
  return `"${token.replaceAll('"', '\\"')}"`
}
