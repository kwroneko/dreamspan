import { EditorTextActions, runEditorShortcut, useEditorFocus } from "../textActions.tsx"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CodeEditorProps } from "./CodeEditor.tsx"
import { changeGutter, comparisonBase, lineChanges, quietMarkers } from "./codeChanges.ts"
import { proseTheme } from "./codeTheme.ts"
import { Dialog } from "./Dialog.tsx"
import { chromeButton, FieldFrame } from "./FieldFrame.tsx"
import { IconButton } from "./Tooltip.tsx"

/** One persistent view: controlled echoes never reset selection or undo history. */
export default function CodeEditorView(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const controller = useRef<ReturnType<typeof mountEditor> | null>(null)
  // The selected text, for the bar's selection actions under the box.
  const [selected, setSelected] = useState("")
  const { focused, onFocus, onBlur } = useEditorFocus()
  const selection = focused ? selected : ""
  // Open large (owner, 2026-11-02): every prose editor's text in a box filling the middle of the
  // screen, bound to the same value and changes, so it's the same draft with the same history.
  const [large, setLarge] = useState(false)
  const expand = props.expand !== false && props.textActions !== false && !props.readOnly
  useLayoutEffect(() => {
    const mounted = mountEditor(host.current!, props, setSelected)
    controller.current = mounted
    return () => {
      mounted.destroy()
      controller.current = null
    }
    // Initial props seed the view; subsequent props are applied without recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLayoutEffect(() => {
    controller.current?.update(props)
  })
  // Some engines finish composition after React's last render. Apply queued external text then.
  useEffect(() => {
    const node = host.current!
    const ended = () => requestAnimationFrame(() => controller.current?.finishComposition())
    node.addEventListener("compositionend", ended)
    return () => node.removeEventListener("compositionend", ended)
  }, [])
  return (
    <div
      className="group/text flex min-w-0 flex-col"
      onFocus={onFocus}
      onBlur={onBlur}
      // A key comes from inside, so the editor has focus: its selection as it is now.
      onKeyDown={(event) =>
        runEditorShortcut(event, props.value, controller.current?.selection() ?? selection, props.source)
      }
    >
      {/* The text actions and the field's own controls in the strip inside its bottom border. */}
      <FieldFrame
        side="bottom"
        strip={props.textActions !== false || props.tools !== undefined || props.status !== undefined}
        status={props.status}
        tools={
          <>
            {props.textActions !== false && (
              <EditorTextActions text={props.value} selection={selection} shown={focused} source={props.source} />
            )}
            {props.tools}
            {expand && (
              <IconButton
                label={`Open ${props.label} large`}
                hint={`Opens ${props.label} large over the page, to write in a bigger box; it's the same text.`}
                icon="expand"
                className={chromeButton}
                onClick={() => setLarge(true)}
              />
            )}
          </>
        }
      >
        <div
          data-layout-audit-ignore="inset: Editor surface fills its own bordered field"
          ref={host}
          className="min-w-0 overflow-hidden rounded-md"
        />
      </FieldFrame>
      {large && (
        <Dialog
          open
          onOpenChange={(open) => !open && setLarge(false)}
          title={props.label}
          wide
          // Back to the box in place, where the same text is.
          finalFocus={() => {
            requestAnimationFrame(() => controller.current?.focus())
            return false
          }}
        >
          <CodeEditorView
            {...props}
            expand={false}
            autoFocus
            selection={undefined}
            minHeight="min(65dvh, 48rem)"
            fullHeight
          />
        </Dialog>
      )}
    </div>
  )
}

/** Text just added, marked for a moment (`flash`); the mark follows edits until it fades. */
const setFlash = StateEffect.define<{ from: number; to: number } | null>()
const flashMark = Decoration.mark({ class: "rp-flash" })
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    marks = marks.map(transaction.changes)
    for (const effect of transaction.effects)
      if (effect.is(setFlash))
        marks =
          effect.value && effect.value.to > effect.value.from
            ? Decoration.set([flashMark.range(effect.value.from, effect.value.to)])
            : Decoration.none
    return marks
  },
  provide: (field) => EditorView.decorations.from(field)
})

function mountEditor(host: HTMLElement, initial: CodeEditorProps, onSelected: (text: string) => void) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" })
  const options = new Compartment()
  let props = initial
  let applying = false
  let deferred: string | null = null
  const attributes = () => [
    EditorState.readOnly.of(props.readOnly ?? false),
    EditorView.contentAttributes.of({
      "aria-label": props.label,
      "aria-multiline": "true",
      spellcheck: String(!props.mono)
    })
  ]
  const view = new EditorView({
    root,
    parent: root,
    state: EditorState.create({
      doc: initial.value,
      extensions: [
        proseTheme,
        EditorView.lineWrapping,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lineChanges,
        changeGutter,
        flashField,
        initial.quietMarkers ? quietMarkers : [],
        options.of(attributes()),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main
            const text = update.state.sliceDoc(range.from, range.to)
            onSelected(text)
            props.onSelectionChange?.(text)
          }
          if (update.docChanged && !applying) {
            deferred = null // A composition edit is now the latest user text.
            props.onChange(update.state.doc.toString())
          }
        }),
        EditorView.domEventHandlers({
          blur: () => {
            props.onBlur?.()
          }
        })
      ]
    })
  })
  const replace = (value: string) => {
    value = view.state.toText(value).toString()
    if (value === view.state.doc.toString()) return
    // Replace only the differing span; CodeMirror maps the cursor through this change.
    const old = view.state.doc.toString()
    let from = 0,
      end = old.length,
      to = value.length
    while (from < end && from < to && old[from] === value[from]) from++
    while (end > from && to > from && old[end - 1] === value[to - 1]) {
      end--
      to--
    }
    applying = true
    try {
      view.dispatch({
        changes: { from, to: end, insert: value.slice(from, to) },
        annotations: Transaction.addToHistory.of(false)
      })
    } finally {
      applying = false
    }
  }
  let selection: CodeEditorProps["selection"]
  let flash: CodeEditorProps["flash"]
  let fade: ReturnType<typeof setTimeout> | undefined
  let base: string | null = null
  const update = (next: CodeEditorProps) => {
    const oldProps = props
    props = next
    host.style.setProperty("--editor-font", next.mono ? "var(--font-mono)" : "var(--font-sans)")
    host.style.setProperty("--editor-max-height", next.fullHeight ? "none" : "min(60vh, 32rem)")
    host.style.setProperty("--editor-min-height", next.minHeight ?? `${Math.min(next.rows ?? 4, 10) * 1.6}em`)
    if (view.composing && next.value !== view.state.doc.toString()) deferred = next.value
    else {
      // An equal-text echo also supersedes any earlier queued external value.
      deferred = null
      replace(next.value)
    }
    if (next.selection && selection !== next.selection) {
      selection = next.selection
      const anchor = Math.min(selection.at, view.state.doc.length)
      const head = Math.min(anchor + selection.length, view.state.doc.length)
      view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(head, { y: "center" }) })
      requestAnimationFrame(() => {
        if (!host.isConnected) return
        // The host may reveal a closed details section in its effects first.
        view.focus()
        view.requestMeasure({
          read: () => view.coordsAtPos(anchor)?.top,
          write: (top) => {
            if (top !== undefined && host.isConnected) props.onRevealSelection?.(host, top)
          }
        })
      })
    }
    if (next.flash && flash !== next.flash) {
      flash = next.flash
      const from = Math.min(flash.at, view.state.doc.length)
      const to = Math.min(from + flash.length, view.state.doc.length)
      // Scrolls the editor and the panel around it, without taking focus from where the text came from.
      view.dispatch({ effects: [setFlash.of({ from, to }), EditorView.scrollIntoView(to, { y: "nearest" })] })
      clearTimeout(fade)
      fade = setTimeout(() => view.dispatch({ effects: setFlash.of(null) }), 1600)
    }
    if (base !== next.base) {
      base = next.base
      view.dispatch({ effects: comparisonBase.of(base) })
    }
    if (oldProps.readOnly !== next.readOnly || oldProps.label !== next.label || oldProps.mono !== next.mono)
      view.dispatch({ effects: options.reconfigure(attributes()) })
  }
  update(initial)
  if (initial.autoFocus) {
    // The caret at the end, where an edit usually goes on, or where it was asked to be,
    // scrolled into view with the page.
    const caret = Math.min(Math.max(0, initial.caret ?? view.state.doc.length), view.state.doc.length)
    view.dispatch({ selection: { anchor: caret }, scrollIntoView: true })
    view.focus()
  }
  return {
    update,
    /** The selected text now, which a render may not have caught up with. */
    selection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    focus: () => view.focus(),
    finishComposition() {
      if (deferred !== null) {
        const value = deferred
        deferred = null
        replace(value)
      }
    },
    destroy: () => {
      clearTimeout(fade)
      view.destroy()
    }
  }
}
