import { mediaQueue, mapCssMedia, PENDING_MEDIA } from "./mediaQueue.ts"
import type { MediaPermit } from "./media.ts"
// What message HTML needs from around it (spec/HTML-MESSAGES.md §3.2, §3.3): the viewer's choices,
// the message a body belongs to, and the chat view's card styles in one constructed stylesheet.
import { createContext } from "react"
import type { FrameSlots } from "./frames.ts"
import type { PanelDataSource } from "./parts.ts"
import type { SlotId } from "@dreamspan/shared/chat.ts"

/**
 * Scopes a text's CSS (css.ts). The renderer's lazy chunk sets it, so its CSS parser stays out
 * of the app's first load; stored texts wait for it, as no message has rendered before it.
 */
let scoper: ((styles: ReadonlyArray<string>, key: string) => string) | null = null
const sheets = new Set<MessageStyles>()
export function setStyleScoper(scope: (styles: ReadonlyArray<string>, key: string) => string) {
  if (scoper) return
  scoper = scope
  for (const styles of sheets) styles.refresh()
}

/** The viewer's choices (account display preferences), from the chat view; on everywhere else. */
export interface HtmlSettings {
  /** "Show HTML as formatting": off, HTML shows as text. */
  readonly html: boolean
  /** "Run panels in the last N messages": null, every message's. */
  readonly panelDepth: number | null
}
export const HtmlSettingsContext = createContext<HtmlSettings>({ html: true, panelDepth: null })

/** The chat message a body shows, set by its body only: reasoning and previews have none. */
export interface HtmlMessage {
  /** Its slot: the row, whichever version shows. */
  readonly key: string
  /** The chat message's slot, for what its panels may read; absent outside a chat. */
  readonly slotId?: SlotId
  readonly media?: MediaPermit
  /** Its reply is being written: its panels wait ("Panel loading"). */
  readonly streaming?: boolean
  /** How far it is from the viewed fork's tip (0 is the last message), when known. */
  readonly fromTip?: number | null
  /** What its panels may run (spec/HTML-MESSAGES.md §3.4); absent, scripts stay off. */
  readonly permit?: PanelPermit
}

/**
 * What a message's panels may run: scripts when every source that could have written them
 * allowed it (its card, and the preset when its scripts write scripts), the internet when they
 * all allowed that too.
 */
export interface PanelPermit {
  readonly scripts: boolean
  readonly network: boolean
  /** With scripts off: the first source still to allow them, and allowing it. */
  readonly ask: { readonly name: string; readonly allow: () => Promise<boolean> } | null
}
export const HtmlMessageContext = createContext<HtmlMessage | null>(null)

/**
 * Whether a block has scripts of its own: a script element, or an event handler attribute (a
 * space and `on…=` inside a tag, after a `<` with no `>` since). One pass over the text: the
 * regex this replaces rescanned to the end from every `<`, quadratic on a run of them.
 */
export function panelHasScripts(html: string): boolean {
  if (/<script\b/i.test(html)) return true
  const handler = /on[a-z]+\s*=/iy
  let inTag = false
  for (let at = 0; at < html.length; at++) {
    const char = html[at]!
    if (char === "<") inTag = true
    else if (char === ">") inTag = false
    else if (inTag && /\s/.test(char)) {
      handler.lastIndex = at + 1
      if (handler.test(html)) return true
    }
  }
  return false
}

/**
 * Whether a line has `![` and a `]` after it (what `/!\[.*?\]/` tests), in one pass: the regex
 * rescanned the rest of the line from every `![`, quadratic on a long line of them.
 */
export function hasImageSyntax(text: string): boolean {
  let open = false
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (char === "\n" || char === "\r" || char === " " || char === " ") open = false
    else if (char === "!" && text[at + 1] === "[") {
      open = true
      at++
    } else if (char === "]" && open) return true
  }
  return false
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/gm
const FENCED = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/my

/**
 * Keep the old fence matching exactly (including its multiline `$`). Only try the full
 * pattern once an opener has a following newline: otherwise its two greedy runs backtrack
 * quadratically over an unterminated line of backticks. Every successful match advances both
 * searches past that block; when no newline remains, no later opener can match either.
 */
function withoutFences(text: string): string {
  const pieces: string[] = []
  let from = 0
  FENCE_OPEN.lastIndex = 0
  for (let open = FENCE_OPEN.exec(text); open; open = FENCE_OPEN.exec(text)) {
    if (text.indexOf("\n", FENCE_OPEN.lastIndex) < 0) break
    FENCED.lastIndex = open.index
    const match = FENCED.exec(text)!
    pieces.push(text.slice(from, match.index))
    from = FENCED.lastIndex
    FENCE_OPEN.lastIndex = from
  }
  pieces.push(text.slice(from))
  return pieces.join("")
}

const STYLE_OPEN = /<style(?!\w)/gi
const STYLE_CLOSE = /<\/style\s*>/gi

/**
 * The CSS of each of a text's `<style>` elements, as ST takes it from the text before formatting
 * it (encodeStyleTags: `<style\b[^>]*>` to `</style>` or the end), but not from inside code
 * blocks. Found with forward searches only, so the work is linear in the text: the regex this
 * replaces rescanned to the end from every `<style` without a `>` (quadratic: seconds on a
 * long reply).
 */
export function extractStyles(text: string): ReadonlyArray<string> {
  if (!/<style/i.test(text)) return []
  const source = withoutFences(text)
  const styles: string[] = []
  STYLE_OPEN.lastIndex = 0
  for (let open = STYLE_OPEN.exec(source); open; open = STYLE_OPEN.exec(source)) {
    const start = source.indexOf(">", open.index + 6)
    // No `>` after this `<style`, so none after any later one either.
    if (start < 0) break
    STYLE_CLOSE.lastIndex = start + 1
    const close = STYLE_CLOSE.exec(source)
    styles.push(source.slice(start + 1, close ? close.index : source.length))
    if (!close) break
    STYLE_OPEN.lastIndex = close.index + close[0].length
  }
  return styles
}

/**
 * The chat view's card styles: one constructed stylesheet on the document (`style-src 'self'`
 * doesn't govern it, where a `<style>` element couldn't apply), from every message in the
 * loaded window, scoped to message bodies, so a greeting's style keeps applying while the
 * greeting is scrolled away. A body that rendered reports its display text's styles; a message
 * that hasn't rendered yet contributes its stored text's.
 */
export class MessageStyles {
  private readonly mediaReleases = new Map<string, () => void>()
  private readonly reportedMedia = new Map<string, ReadonlyArray<string>>()
  private readonly reported = new Map<string, string>()
  private loaded: ReadonlyArray<{ readonly key: string; readonly text: string }> = []
  private readonly stored = new Map<string, { readonly text: string; readonly css: string }>()
  private sheet: CSSStyleSheet | null = null
  private applied = ""
  private scheduled = false

  /** Adopts the sheet while the chat view is open; the returned function takes it away. */
  attach(): () => void {
    if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return () => {}
    const sheet = new CSSStyleSheet()
    this.sheet = sheet
    this.applied = ""
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    sheets.add(this)
    this.flush()
    return () => {
      sheets.delete(this)
      for (const release of this.mediaReleases.values()) release()
      this.mediaReleases.clear()
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet)
      if (this.sheet === sheet) this.sheet = null
    }
  }

  /** A rendered body's scoped CSS (display text). It stays after the row unmounts. */
  report(key: string, css: string, media: ReadonlyArray<string> = []) {
    this.reportedMedia.set(key, media)
    if (this.reported.get(key) === css) return
    this.reported.set(key, css)
    this.schedule()
  }

  /** Consent revisions invalidate offscreen reports too. Visible rows report again. */
  clearReports() {
    for (const [key, css] of this.reported)
      this.reported.set(
        key,
        mapCssMedia(css, () => PENDING_MEDIA)
      )
    this.reportedMedia.clear()
    this.schedule()
  }

  /** The loaded window, oldest first; styles of messages outside it go. */
  setLoaded(entries: ReadonlyArray<{ readonly key: string; readonly text: string }>) {
    this.loaded = entries
    const keys = new Set(entries.map((entry) => entry.key))
    for (const key of [...this.reported.keys()])
      if (!keys.has(key)) {
        this.reported.delete(key)
        this.reportedMedia.delete(key)
      }
    for (const key of [...this.stored.keys()]) if (!keys.has(key)) this.stored.delete(key)
    this.schedule()
  }

  /** The stylesheet's text: each loaded message's styles in order, so later ones win as in ST. */
  text(): string {
    return this.loaded
      .map((entry) => {
        const reported = this.reported.get(entry.key)
        if (reported !== undefined) return reported
        const cached = this.stored.get(entry.key)
        if (cached?.text === entry.text) return cached.css
        if (!scoper) return ""
        const css = scoper(extractStyles(entry.text), entry.key)
        this.stored.set(entry.key, { text: entry.text, css })
        return css
      })
      .filter((css) => css !== "")
      .join("\n")
  }

  /** Recomputes the sheet (the scoper arrived). */
  refresh() {
    this.schedule()
  }

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.flush()
    })
  }
  private flush() {
    if (!this.sheet) return
    const source = this.text()
    const addresses = new Set(this.loaded.flatMap((entry) => this.reportedMedia.get(entry.key) ?? []))
    for (const [url, release] of this.mediaReleases)
      if (!addresses.has(url)) {
        release()
        this.mediaReleases.delete(url)
      }
    for (const url of addresses)
      if (!this.mediaReleases.has(url))
        this.mediaReleases.set(
          url,
          mediaQueue.retain(url, () => this.schedule())
        )
    const text = mapCssMedia(source, (url) =>
      addresses.has(url) ? (mediaQueue.read(url) ?? PENDING_MEDIA) : PENDING_MEDIA
    )
    if (text === this.applied) return
    this.applied = text
    this.sheet.replaceSync(text)
  }
}

/** The chat view's shared HTML state, provided by the chat surface (features/chat). */
export interface HtmlChat {
  readonly styles: MessageStyles
  /** Its live panel frames (frames.ts). */
  readonly frames: FrameSlots
  /** What its panels' scripts may read (Tier B); absent outside a chat view. */
  readonly panelData?: PanelDataSource
}
export const HtmlChatContext = createContext<HtmlChat | null>(null)
