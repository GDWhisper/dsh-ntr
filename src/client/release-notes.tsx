/**
 * The release-notes preview inside the settings update card.
 *
 * The host delivers ONE body per version, in the GitHub Release's published
 * shape: Chinese half, a line holding only `---`, English half. Choosing the
 * half happens HERE, at render time, because the browser owns the locale —
 * the host never guesses a language.
 *
 * The body is rendered by a deliberately tiny markdown pass (headings, lists,
 * `**bold**`, `` `code` ``, `[text](url)`). No dependency, and never
 * `dangerouslySetInnerHTML`: the body is remote text, so anything the pass does
 * not understand stays literal text — an `<img onerror=…>` in a release note is
 * shown as the characters it is.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AcpStore } from './store.ts'
import type { PluginReleaseNotes, PluginUpdateState } from '../protocol.ts'
import { pluginReleaseUrl } from '../protocol.ts'

/**
 * The half of a bilingual body to draw.
 *
 * Halves are separated by a line whose trimmed content is exactly `---` — the
 * same line the release process puts between them. Exactly two halves means
 * "pick one"; anything else (one half only, or more separators than that) is
 * returned whole, because guessing which part a reader wants is worse than
 * showing what was published.
 */
export function pickReleaseLanguage(body: string, zh: boolean): string {
  const halves = splitHalves(body)
  if (halves.length !== 2) return body.trim()
  return (zh ? halves[0] : halves[1]).trim()
}

function splitHalves(body: string): string[] {
  const halves: string[] = []
  let current: string[] = []
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '---') {
      halves.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  halves.push(current.join('\n'))
  return halves
}

/**
 * Which version's notes the card should show, per state.
 *
 * - `available` / `applying`: the version being offered / installed.
 * - `applied` / `restart-required`: the version now on disk.
 * - `current`: whatever the registry calls latest (else the running one).
 * - `failed` / `busy`: the version the card names as the target.
 * - everything else describes an install this card cannot update.
 */
export function releaseNoteVersion(update: PluginUpdateState): string | undefined {
  switch (update.status) {
    case 'available':
    case 'applying':
      return update.latest ?? update.installed
    case 'applied':
    case 'restart-required':
      return update.installed ?? update.latest
    case 'current':
      return update.latest ?? update.current
    case 'failed':
    case 'busy':
      return update.latest
    default:
      return undefined
  }
}

/** One inline run: everything the tiny pass understands, else plain text. */
function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const [, linkText, href, strong, code] = match
    const key = `${keyPrefix}-${String(index)}`
    if (linkText !== undefined && href !== undefined) {
      // Only a web address is a link. Anything else (`javascript:`, a bare
      // path) stays the literal markdown text it was written as.
      nodes.push(/^https?:\/\//i.test(href)
        ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{linkText}</a>
        : match[0])
    } else if (strong !== undefined) {
      nodes.push(<strong key={key}>{strong}</strong>)
    } else if (code !== undefined) {
      nodes.push(<code key={key}>{code}</code>)
    }
    last = match.index + match[0].length
    index += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** One heading at h4–h6: a release body must not outrank the page it sits in. */
function headingNode(hashes: number, text: string, key: string): ReactNode {
  const level = Math.min(6, Math.max(4, hashes + 2))
  const content = inlineNodes(text, key)
  if (level === 4) return <h4 key={key}>{content}</h4>
  if (level === 5) return <h5 key={key}>{content}</h5>
  return <h6 key={key}>{content}</h6>
}

/** The tiny markdown pass: headings, `- ` lists, blank-line paragraphs. */
function markdownNodes(body: string): ReactNode[] {
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let list: string[] = []
  let seq = 0
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const key = `p${String(seq++)}`
    blocks.push(<p key={key}>{inlineNodes(paragraph.join(' '), key)}</p>)
    paragraph = []
  }
  const flushList = (): void => {
    if (list.length === 0) return
    const key = `l${String(seq++)}`
    blocks.push(
      <ul key={key}>
        {list.map((item, itemIndex) => <li key={`${key}-${String(itemIndex)}`}>{inlineNodes(item, `${key}-${String(itemIndex)}`)}</li>)}
      </ul>,
    )
    list = []
  }
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flushParagraph()
      flushList()
      blocks.push(headingNode(heading[1].length, heading[2], `h${String(seq++)}`))
      continue
    }
    if (trimmed.startsWith('- ')) {
      flushParagraph()
      list.push(trimmed.slice(2))
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }
  flushParagraph()
  flushList()
  return blocks
}

/**
 * The preview under the update card's copy.
 *
 * The section exists only while the card names a version this build can
 * describe; the release PAGE is drawn in every case that does (a body is
 * fetched on demand and may legitimately be unavailable). Fetching starts when
 * the card opens — never at mount of the settings page, and never as part of
 * the update CHECK, which must not touch GitHub.
 */
export function ReleaseNotesSection(props: { acp: AcpStore; update: PluginUpdateState }) {
  const { acp, update } = props
  const version = releaseNoteVersion(update)
  const [loaded, setLoaded] = useState<{ version: string; notes: PluginReleaseNotes } | undefined>(undefined)
  // First frame is the loading line, never "unavailable": the read has not
  // been answered yet, and the failure copy must not flash on every open.
  const [loading, setLoading] = useState(true)
  /**
   * Retry counter, keyed by version: `n > 0` makes the read bypass every cache.
   * Keying it means a retry on one version does not turn every later version
   * into a forced read.
   */
  const [attempt, setAttempt] = useState<{ version?: string; n: number }>({ n: 0 })
  const forced = attempt.version === version ? attempt.n : 0

  useEffect(() => {
    if (version === undefined) return
    // A read that lands after unmount (or after the version changed) must not
    // write state: the card can be closed while GitHub is still answering.
    let live = true
    setLoading(true)
    void acp.loadPluginReleaseNotes(version, forced > 0)
      .then(result => {
        if (!live) return
        setLoaded(result === undefined ? undefined : { version, notes: result })
        setLoading(false)
      })
      .catch(() => {
        if (live) setLoading(false)
      })
    return () => { live = false }
  }, [acp, version, forced])

  if (version === undefined) return null
  const notes = loaded?.version === version ? loaded.notes : undefined
  // Derived, not just the state flag: a VERSION CHANGE re-renders before the
  // effect runs, and a bare `loading` would flash "unavailable" for that frame.
  const pending = loading || loaded?.version !== version
  const body = notes?.body !== undefined && notes.body !== '' ? notes.body : undefined
  const text = body === undefined ? undefined : pickReleaseLanguage(body, acp.prefersZh())
  const page = notes?.url ?? pluginReleaseUrl(version)
  const head = acp.label(`发布说明 v${version}`, `Release notes v${version}`)

  return (
    <section className="dwa-update-notes" aria-label={head}>
      <h3 className="dwa-update-notes-head">{head}</h3>
      {pending && <div className="dwa-hint">{acp.label('正在加载发布说明…', 'Loading release notes…')}</div>}
      {!pending && text !== undefined && <div className="dwa-update-notes-body">{markdownNodes(text)}</div>}
      {!pending && text === undefined && (
        <div className="dwa-hint">{acp.label('发布说明暂不可用。', 'Release notes are unavailable.')}</div>
      )}
      {!pending && text !== undefined && notes?.truncated === true && (
        <div className="dwa-hint">{acp.label('发布说明过长，已截断。', 'The release notes were truncated.')}</div>
      )}
      {/* Retry only for a REAL failure. An older host answers no body and no
          reason, and retrying an endpoint that does not exist cannot help. */}
      {!pending && text === undefined && notes?.message !== undefined && (
        <div>
          <button
            type="button"
            className="dwa-btn dwa-btn-quiet"
            onClick={() => setAttempt(prev => ({
              version,
              n: prev.version === version ? prev.n + 1 : 1,
            }))}
          >
            {acp.label('重试', 'Retry')}
          </button>
        </div>
      )}
      <div className="dwa-update-notes-url">
        {acp.label('发布页：', 'Release page: ')}
        <a href={page} target="_blank" rel="noreferrer noopener">{page}</a>
      </div>
    </section>
  )
}
