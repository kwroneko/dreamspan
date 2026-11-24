// The message editor's text styled as the message renders it (messageStyles.ts), as CodeMirror
// marks: dialogue in the quote color, italics in italic and the italics color, bold bold, and
// the Markdown marks themselves dimmed. The text stays the stored text; only its look changes.
//
// The styles open with the editor, computed once on the page's thread so its first frame looks
// like the message did. After that a keystroke never parses here: the marks move with the edit
// at once (CodeMirror maps them), and the text goes to a worker, which reparses only the block
// that changed and answers with the new ranges. One request is out at a time; an answer for an
// older text is moved through the edits made since, and the latest text is asked for next.
import { ChangeSet, type Extension, StateEffect, StateField, Transaction } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view"
import { messageBlockLines } from "./messageBlockLines.ts"
import { messageStyleRanges, STYLE_KINDS, styleCache, type StyleRanges } from "./messageStyles.ts"

export interface StyleRequest {
  readonly editor: number
  readonly id: number
  readonly text: string
  readonly html: boolean
  /** Example dialogue (StyleOptions `examples`). */
  readonly examples?: boolean
  /** The editor closed: its blocks can go. */
  readonly close?: boolean
}
export interface StyleResponse {
  readonly editor: number
  readonly id: number
  readonly ranges: StyleRanges
}

const marks = STYLE_KINDS.map((kind) => Decoration.mark({ class: `rp-md-${kind}` }))

/** The ranges as marks, for a text `length` long. */
function decorations(ranges: StyleRanges, length: number): DecorationSet {
  const out = []
  for (let i = 0; i < ranges.length; i += 3) {
    const from = ranges[i]!
    const to = Math.min(ranges[i + 1]!, length)
    if (to > from) out.push(marks[ranges[i + 2]!]!.range(from, to))
  }
  return Decoration.set(out, true)
}

// One worker for every message editor; null where workers can't run (styling then runs here, after the keystroke).
let worker: Worker | null | undefined
const answers = new Map<number, (response: StyleResponse) => void>()
let editors = 0
const styleWorker = (): Worker | null => {
  if (worker !== undefined) return worker
  try {
    worker = new Worker(new URL("./messageStyles.worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (event: MessageEvent<StyleResponse>) => answers.get(event.data.editor)?.(event.data)
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      // Whatever was asked is answered here instead.
      for (const answer of answers.values()) answer({ editor: -1, id: -1, ranges: new Int32Array() })
    }
  } catch {
    worker = null
  }
  return worker
}

const setStyles = StateEffect.define<DecorationSet>()

/**
 * Fields (`StylingPlace.field`) style their text on the page as they open only so far: each at
 * most FIELD_FIRST characters (more than its bounded box shows), and the fields opening in one
 * task (a card's thirty greetings) FIELD_BUDGET between them, in the order they open, top first.
 * The worker styles the rest right after. A message's own editor styles all of its text at once.
 */
const FIELD_FIRST = 4000
const FIELD_BUDGET = 12_000
let fieldBudget = FIELD_BUDGET
let refill: ReturnType<typeof setTimeout> | undefined
/** How much of `text` a field opening now styles on the page. */
function fieldShare(text: string): number {
  refill ??= setTimeout(() => {
    fieldBudget = FIELD_BUDGET
    refill = undefined
  }, 0)
  const share = Math.min(text.length, FIELD_FIRST, fieldBudget)
  fieldBudget -= share
  if (share === text.length || share === 0) return share
  // To a line's end, so no line shows half styled.
  const end = text.indexOf("\n", share)
  return end === -1 ? text.length : end
}

/** Where the styled text is beyond a message's own editor (CodeEditorProps `messageField`). */
export interface StylingPlace {
  /**
   * A form field holding message text (a card's greeting): the marks and the message's colors,
   * with the field's own font, size, line height and padding, as the fields around it have.
   */
  readonly field?: boolean
  /** Example dialogue: its `<START>` lines and speaker prefixes stay as they are (StyleOptions `examples`). */
  readonly examples?: boolean
}

/** The message editor's styling; `html` as the message shows HTML ("Show HTML as formatting"). */
export function messageStyling(html: boolean, place: StylingPlace = {}): Extension {
  const examples = place.examples === true
  const options = { html, examples }
  // The page's own copy of the blocks, for the first frame and where no worker runs.
  const local = styleCache()
  // A field shows the start of its text (its height is bounded) and a card has many: the page
  // styles its share (`fieldShare`) at once, and `partial` asks the worker for the rest.
  let partial = false
  const shown = (text: string) => {
    if (!place.field) return text
    const share = fieldShare(text)
    partial = share < text.length
    return text.slice(0, share)
  }
  const field = StateField.define<DecorationSet>({
    create: (state) => decorations(messageStyleRanges(shown(state.doc.toString()), options, local), state.doc.length),
    update(set, transaction) {
      // Text put in from outside rather than typed (the composer's draft arriving as the page
      // opens, a restore, another tab's text) is styled at once, as an opening editor's is, so it
      // never shows plain first; typing and pasting only map the marks and leave the rest to the worker.
      if (transaction.docChanged && transaction.annotation(Transaction.userEvent) === undefined)
        return decorations(
          messageStyleRanges(shown(transaction.newDoc.toString()), options, local),
          transaction.newDoc.length
        )
      set = set.map(transaction.changes)
      for (const effect of transaction.effects) if (effect.is(setStyles)) set = effect.value
      return set
    },
    provide: (f) => EditorView.decorations.from(f)
  })
  const plugin = ViewPlugin.fromClass(
    class {
      readonly editor = ++editors
      id = 0
      /** The request out: its id and the edits made since its text. */
      out: { id: number; length: number; since: ChangeSet } | null = null
      /** The text changed since the last request. */
      dirty = false
      /** An answer kept while an IME composes, applied when it ends. */
      held: DecorationSet | null = null
      timer: ReturnType<typeof setTimeout> | undefined
      closed = false
      readonly view: EditorView
      constructor(view: EditorView) {
        this.view = view
        answers.set(this.editor, (response) => this.receive(response))
        // Only part of it was styled as it opened (`shown`): the rest now.
        if (partial) this.send()
      }
      update(update: ViewUpdate) {
        if (update.docChanged) {
          // Text put in from outside was styled whole (the field): an answer for the text before
          // it, or one held through a composition, would only cover it with stale marks.
          if (update.transactions.some((tr) => tr.docChanged && tr.annotation(Transaction.userEvent) === undefined)) {
            this.out = null
            this.held = null
          }
          if (this.out) this.out = { ...this.out, since: this.out.since.compose(update.changes) }
          if (this.held) this.held = this.held.map(update.changes)
          this.dirty = true
          if (!this.out) this.send()
        }
        if (this.held && !update.view.composing) {
          const held = this.held
          this.held = null
          queueMicrotask(() => this.apply(held))
        }
      }
      send() {
        const text = this.view.state.doc.toString()
        const id = ++this.id
        this.out = { id, length: text.length, since: ChangeSet.empty(text.length) }
        this.dirty = false
        const target = styleWorker()
        if (target) target.postMessage({ editor: this.editor, id, text, html, examples } satisfies StyleRequest)
        else {
          // No worker: after this keystroke's frame, here.
          clearTimeout(this.timer)
          this.timer = setTimeout(
            () => this.receive({ editor: this.editor, id, ranges: messageStyleRanges(text, options, local) }),
            0
          )
        }
      }
      receive(response: StyleResponse) {
        const out = this.out
        if (!out || this.closed) return
        if (response.id === -1) {
          // The worker failed: ask again, here.
          this.out = null
          this.send()
          return
        }
        if (response.id !== out.id) return
        this.out = null
        const set = decorations(response.ranges, out.length).map(out.since)
        if (this.view.composing) this.held = set
        else this.apply(set)
        if (this.dirty) this.send()
      }
      apply(set: DecorationSet) {
        if (!this.closed) this.view.dispatch({ effects: setStyles.of(set) })
      }
      destroy() {
        this.closed = true
        clearTimeout(this.timer)
        answers.delete(this.editor)
        worker?.postMessage({ editor: this.editor, id: 0, text: "", html, close: true } satisfies StyleRequest)
      }
    }
  )
  return [
    field,
    plugin,
    messageBlockLines(examples),
    messageTextTheme,
    // A field keeps the font, size, line height and surface the fields around it have.
    place.field ? [] : messageBoxTheme,
    EditorView.editorAttributes.of({ class: "rp-message-text" })
  ]
}

/**
 * The look of the message's text (styles.css "Message text"), in the editor's shadow root where
 * the page's rules don't reach: the same tokens, so a theme or a chosen message color applies to
 * both.
 */
const messageTextTheme = EditorView.theme({
  "&.rp-message-text": { color: "var(--color-message-main)" },
  "&.rp-message-text .cm-content": { caretColor: "var(--color-message-main)" },
  "&.rp-message-text .cm-cursor, &.rp-message-text .cm-dropCursor": {
    borderLeftColor: "var(--color-message-main)"
  },
  ".rp-md-em": { color: "var(--color-message-italics)", fontStyle: "italic" },
  ".rp-md-quote": { color: "var(--color-message-quote)" },
  ".rp-md-quote .rp-md-em": { color: "inherit" },
  ".rp-md-underline": { color: "var(--color-message-underline)", textDecoration: "underline" },
  ".rp-md-strong": { fontWeight: "600" },
  ".rp-md-strike": { textDecoration: "line-through" },
  ".rp-md-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "3px" },
  ".rp-md-h1, .rp-md-h2, .rp-md-h3, .rp-md-h4": { fontWeight: "600", lineHeight: "1.3" },
  ".rp-md-h1": { fontSize: "1.4em" },
  ".rp-md-h2": { fontSize: "1.25em" },
  ".rp-md-h3": { fontSize: "1.1em" },
  ".rp-md-blockquote": { color: "var(--text-muted)" },
  ".rp-md-code": {
    color: "var(--color-message-main)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    background: "var(--surface-raised)",
    borderRadius: "4px"
  },
  ".rp-md-pre": { fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  ".rp-md-pre .rp-md-code": { background: "none" },
  // The marks themselves: still there to edit, quieter than the text they mark.
  ".rp-md-syntax": { opacity: "0.55" }
})

/**
 * A message's own editor: font, size, line height and wrapping come from the box the editor is
 * in (`.message-edit-text`, which shares the message's rule), with no padding of the editor's own.
 */
const messageBoxTheme = EditorView.theme({
  "&.rp-message-text": { fontSize: "inherit", backgroundColor: "transparent" },
  "&.rp-message-text .cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  "&.rp-message-text .cm-content": { padding: "var(--bare-padding, 0)" },
  "&.rp-message-text .cm-line": { padding: "0" }
})
