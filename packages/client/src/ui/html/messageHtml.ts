// What message HTML needs from around it (spec/HTML-MESSAGES.md §3.2, §3.3): the viewer's choices,
// the message a body belongs to, and the chat view's card styles in one constructed stylesheet.
import { createContext } from "react"
import type { FrameSlots } from "./frames.ts"

/**
 * Scopes a text's CSS (css.ts). The renderer's lazy chunk sets it, so its CSS parser stays out
 * of the app's first load; stored texts wait for it, as no message has rendered before it.
 */
let scoper: ((styles: ReadonlyArray<string>) => string) | null = null
const sheets = new Set<MessageStyles>()
export function setStyleScoper(scope: (styles: ReadonlyArray<string>) => string) {
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
  /** Its reply is being written: its panels wait ("Panel loading"). */
  readonly streaming?: boolean
  /** How far it is from the viewed fork's tip (0 is the last message), when known. */
  readonly fromTip?: number | null
}
export const HtmlMessageContext = createContext<HtmlMessage | null>(null)

const FENCED = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm
const STYLE = /<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi

/**
 * The CSS of each of a text's `<style>` elements, as ST takes it from the text before formatting
 * it (encodeStyleTags), but not from inside code blocks.
 */
export function extractStyles(text: string): ReadonlyArray<string> {
  if (!/<style/i.test(text)) return []
  return [...text.replace(FENCED, "").matchAll(STYLE)].map((match) => match[1]!)
}

/**
 * The chat view's card styles: one constructed stylesheet on the document (`style-src 'self'`
 * doesn't govern it, where a `<style>` element couldn't apply), from every message in the
 * loaded window, scoped to message bodies, so a greeting's style keeps applying while the
 * greeting is scrolled away. A body that rendered reports its display text's styles; a message
 * that hasn't rendered yet contributes its stored text's.
 */
export class MessageStyles {
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
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet)
      if (this.sheet === sheet) this.sheet = null
    }
  }

  /** A rendered body's scoped CSS (display text). It stays after the row unmounts. */
  report(key: string, css: string) {
    if (this.reported.get(key) === css) return
    this.reported.set(key, css)
    this.schedule()
  }

  /** The loaded window, oldest first; styles of messages outside it go. */
  setLoaded(entries: ReadonlyArray<{ readonly key: string; readonly text: string }>) {
    this.loaded = entries
    const keys = new Set(entries.map((entry) => entry.key))
    for (const key of [...this.reported.keys()]) if (!keys.has(key)) this.reported.delete(key)
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
        const css = scoper(extractStyles(entry.text))
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
    const text = this.text()
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
}
export const HtmlChatContext = createContext<HtmlChat | null>(null)
