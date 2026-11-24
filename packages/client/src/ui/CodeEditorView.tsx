import { EditorTextActions, runEditorShortcut, useEditorFocus } from "../textActions.tsx"
import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands"
import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView, keymap, placeholder } from "@codemirror/view"
import { type CSSProperties, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import type { CodeEditorProps } from "./CodeEditor.tsx"
import { changeGutter, comparisonBase, lineChanges, quietMarkers } from "./codeChanges.ts"
import { editorExtensions } from "./editorExtensions.ts"
import { bareText, proseTheme } from "./codeTheme.ts"
import { loadLanguage } from "./codeLanguages.ts"
import { FieldRevertButton } from "./FieldRevertButton.tsx"
import { holdCaretAt } from "./holdCaret.ts"
import { FieldFrame } from "./FieldFrame.tsx"
import { ExpandLink } from "./ExpandLink.tsx"
import { HeightGrip } from "./HeightGrip.tsx"

/** One persistent view: controlled echoes never reset selection or undo history. */
export default function CodeEditorView({ ref, ...props }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const controller = useRef<ReturnType<typeof mountEditor> | null>(null)
  // The selected text, for the bar's selection actions under the box.
  const [selected, setSelected] = useState("")
  const { focused, onFocus, onBlur } = useEditorFocus()
  const selection = focused ? selected : ""
  // A host placing the selection's actions itself (`bare`) hears the same: the selection while
  // the box has focus, none once it's left for another box, which keeps it unseen.
  const reportSelection = props.onSelectionChange
  useEffect(() => reportSelection?.(selection), [reportSelection, selection])
  const [reverting, setReverting] = useState(false)
  // A corner grip sets the box's height, as a textarea's corner does; a box filling its place
  // (`fill`, a field's own tab) takes that place's height instead.
  const resizable = props.resizable !== false && !props.fill
  const strip =
    props.textActions !== false ||
    props.tools !== undefined ||
    props.status !== undefined ||
    props.lastRevision !== undefined
  // Without a strip, the grip sits over the box's bottom-right corner, in its bottom padding.
  const cornerGrip = resizable && !strip
  useLayoutEffect(() => {
    const mounted = mountEditor(host.current!, props, setSelected)
    controller.current = mounted
    // Its text is in the page now, styled: a host swaps it in before this frame is painted.
    props.onReady?.()
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
  useImperativeHandle(ref, () => ({ focus: (at?: number) => controller.current?.focus(at) }), [])
  // Some engines finish composition after React's last render. Apply queued external text then.
  useEffect(() => {
    const node = host.current!
    const ended = () => requestAnimationFrame(() => controller.current?.finishComposition())
    node.addEventListener("compositionend", ended)
    return () => node.removeEventListener("compositionend", ended)
  }, [])
  return (
    <div
      className={`group/text flex min-w-0 flex-col ${props.fill ? "min-h-0 flex-1" : ""}`}
      onFocus={onFocus}
      onBlur={onBlur}
      // A key comes from inside, so the editor has focus: its selection as it is now.
      onKeyDown={(event) =>
        runEditorShortcut(event, props.value, controller.current?.selection() ?? selection, props.source)
      }
    >
      {props.bare ? (
        // In place of the text it edits: the host frames it and places its actions (`bare`).
        <div
          data-layout-audit-ignore="inset: Editor text in place of the text it edits"
          ref={host}
          className={`min-w-0${props.surfaceClass ? ` ${props.surfaceClass}` : ""}`}
        />
      ) : (
        // The text actions and the field's own controls in the strip inside its bottom border.
        <FieldFrame
          side="bottom"
          className={props.fill ? "min-h-0 flex-1" : ""}
          strip={strip}
          status={props.status}
          grip={
            resizable ? (
              <HeightGrip
                corner={cornerGrip}
                label={props.label}
                height={() => host.current!.getBoundingClientRect().height}
                onHeight={(height) => controller.current?.setHeight(height)}
                onReset={() => controller.current?.setHeight(null)}
              />
            ) : undefined
          }
          tools={
            <>
              {/* The selection's buttons stay, disabled without one: on a phone the strip is full, and
                  one coming would wrap the token count onto a second line (owner, 2026-11-24). */}
              {props.textActions !== false && (
                <EditorTextActions
                  text={props.value}
                  selection={selection}
                  shown={focused}
                  source={props.source}
                  keepSelection
                />
              )}
              {props.tools}
              {props.lastRevision !== undefined && !props.readOnly && (
                <FieldRevertButton
                  changed={props.value !== props.lastRevision}
                  pending={reverting}
                  onRevert={() => {
                    const before = props.value
                    const saved = props.lastRevision!
                    setReverting(true)
                    void (props.onRevert?.() ?? Promise.resolve(true)).then((restored) => {
                      setReverting(false)
                      if (restored) controller.current?.edit(saved, before)
                    })
                  }}
                />
              )}
              {props.expandTab !== undefined && <ExpandLink label={props.label} {...props.expandTab} />}
            </>
          }
        >
          <div
            data-layout-audit-ignore="inset: Editor surface fills its own bordered field"
            ref={host}
            className={`min-w-0 overflow-hidden rounded-md ${props.fill ? "min-h-0 flex-1" : ""}`}
            style={cornerGrip ? ({ "--editor-grip-room": "8px" } as CSSProperties) : undefined}
          />
        </FieldFrame>
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

const setHighlights = StateEffect.define<CodeEditorProps["highlights"]>()
const searchMark = Decoration.mark({ class: "rp-search-match" })
const searchHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    marks = marks.map(transaction.changes)
    for (const effect of transaction.effects)
      if (effect.is(setHighlights)) {
        marks = Decoration.set(
          (effect.value ?? [])
            .filter((range) => range.length > 0 && range.at + range.length <= transaction.state.doc.length)
            .map((range) => searchMark.range(range.at, range.at + range.length)),
          true
        )
      }
    return marks
  },
  provide: (field) => EditorView.decorations.from(field)
})

const sameAttributes = (a: CodeEditorProps["contentAttributes"], b: CodeEditorProps["contentAttributes"]) => {
  if (a === b) return true
  const keys = Object.keys(a ?? {})
  return keys.length === Object.keys(b ?? {}).length && keys.every((key) => a?.[key] === b?.[key])
}

function mountEditor(host: HTMLElement, initial: CodeEditorProps, onSelected: (text: string) => void) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" })
  const options = new Compartment()
  const contributions = new Compartment()
  const syntax = new Compartment()
  const own = new Compartment()
  let props = initial
  let applying = false
  let deferred: string | null = null
  /** The active press in the text: its focus places its own caret. */
  let pressed: number | null = null
  const pointerEvents = new AbortController()
  const releasePress = (event: PointerEvent) => {
    if (event.pointerId === pressed) pressed = null
  }
  const pointerOptions = { capture: true, signal: pointerEvents.signal }
  host.ownerDocument.addEventListener("pointerup", releasePress, pointerOptions)
  host.ownerDocument.addEventListener("pointercancel", releasePress, pointerOptions)
  const attributes = () => [
    EditorState.readOnly.of(props.readOnly ?? false),
    EditorView.contentAttributes.of({
      ...props.contentAttributes,
      "aria-label": props.label,
      "aria-multiline": "true",
      spellcheck: String(!props.mono)
    }),
    props.placeholder ? placeholder(props.placeholder) : []
  ]
  const view = new EditorView({
    root,
    parent: root,
    state: EditorState.create({
      doc: initial.value,
      extensions: [
        proseTheme,
        contributions.of([]),
        syntax.of([]),
        own.of(initial.extensions ?? []),
        EditorView.lineWrapping,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lineChanges,
        // In place of rendered text, a gutter would move the text off its place.
        initial.bare ? bareText : [changeGutter, initial.quietMarkers ? quietMarkers : []],
        flashField,
        searchHighlights,
        options.of(attributes()),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main
            const text = update.state.sliceDoc(range.from, range.to)
            onSelected(text)
            props.onSelectionRangeChange?.({ at: range.from, length: range.to - range.from })
          }
          if (update.docChanged && !applying) {
            deferred = null // A composition edit is now the latest user text.
            props.onChange(update.state.doc.toString())
          }
        }),
        EditorView.domEventHandlers({
          pointerdown: (event) => {
            pressed = event.pointerId
          },
          // Focus that isn't a press in the text (Tab, a command, a closing dialog, the panel focus
          // guard) keeps the editor's caret and selection, as a textarea's does. The browser keeps
          // no caret in an unfocused editor whose lines were redrawn (a guidance toggle restyles
          // them) and places one at a line's start, which typing would then go to: the editor's
          // own focus writes its selection back. A press places the caret itself.
          focus: (_event, editor) => {
            if (pressed === null) editor.focus()
            pressed = null
          },
          blur: () => {
            props.onBlur?.()
          }
        }),
        // The host's keys and files come first; true from one leaves the event to the host.
        Prec.highest(
          EditorView.domEventHandlers({
            keydown: (event) => props.onKeyDown?.(event) === true,
            paste: (event) => event.clipboardData !== null && props.hostFiles?.(event.clipboardData) === true,
            drop: (event) => event.dataTransfer !== null && props.hostFiles?.(event.dataTransfer) === true
          })
        )
      ]
    })
  })
  let extensionVersion = 0
  const refreshExtensions = () => {
    const version = ++extensionVersion
    void Promise.all(editorExtensions.list().map((entry) => entry.load()))
      .then((extensions) => {
        if (version === extensionVersion) view.dispatch({ effects: contributions.reconfigure(extensions) })
      })
      .catch(() => {
        /* Text remains editable if an optional extension fails to load. */
      })
  }
  const unsubscribe = editorExtensions.subscribe(refreshExtensions)
  refreshExtensions()
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
  view.dispatch({ effects: setHighlights.of(initial.highlights) })
  let selection: CodeEditorProps["selection"]
  let flash: CodeEditorProps["flash"]
  let fade: ReturnType<typeof setTimeout> | undefined
  let base: string | null = null
  let language: string | null = null
  // A height dragged with the box's grip (HeightGrip.tsx): it replaces growing with the text,
  // within the cap, until a double-click on the grip returns to that.
  let chosenHeight: number | null = null
  const size = () => {
    // Filling its place (a field's own tab): as tall as that, scrolling inside.
    if (props.fill) {
      host.style.setProperty("--editor-height", "100%")
      host.style.setProperty("--editor-max-height", "100%")
      host.style.setProperty("--editor-min-height", props.minHeight ?? "100%")
      return
    }
    if (chosenHeight !== null) {
      host.style.setProperty("--editor-height", `${chosenHeight}px`)
      host.style.setProperty("--editor-max-height", "none")
      host.style.setProperty("--editor-min-height", "100%")
      return
    }
    host.style.removeProperty("--editor-height")
    host.style.setProperty("--editor-max-height", props.fullHeight ? "none" : "min(60vh, 32rem)")
    host.style.setProperty("--editor-min-height", props.minHeight ?? `${Math.min(props.rows ?? 4, 10) * 1.6}em`)
  }
  const update = (next: CodeEditorProps) => {
    const oldProps = props
    props = next
    host.style.setProperty("--editor-font", next.mono ? "var(--font-mono)" : "var(--font-sans)")
    size()
    if (view.composing && next.value !== view.state.doc.toString()) deferred = next.value
    else {
      // An equal-text echo also supersedes any earlier queued external value.
      deferred = null
      replace(next.value)
    }
    if (next.highlights !== oldProps.highlights) view.dispatch({ effects: setHighlights.of(next.highlights) })
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
    if ((next.language ?? null) !== language) {
      const wanted = next.language ?? null
      language = wanted
      void (wanted === null ? Promise.resolve([]) : loadLanguage(wanted)).then((extension) => {
        if (language === wanted) view.dispatch({ effects: syntax.reconfigure(extension) })
      })
    }
    if (base !== next.base) {
      base = next.base
      view.dispatch({ effects: comparisonBase.of(base) })
    }
    if (next.extensions !== oldProps.extensions) view.dispatch({ effects: own.reconfigure(next.extensions ?? []) })
    if (
      oldProps.readOnly !== next.readOnly ||
      oldProps.label !== next.label ||
      oldProps.mono !== next.mono ||
      oldProps.placeholder !== next.placeholder ||
      !sameAttributes(oldProps.contentAttributes, next.contentAttributes)
    )
      view.dispatch({ effects: options.reconfigure(attributes()) })
  }
  update(initial)
  let releaseCaret = () => {}
  if (initial.autoFocus) {
    // The caret at the end, where an edit usually goes on, or where it was asked to be,
    // scrolled into view with the page; given the place on screen its line had (a
    // double-click's), held there instead (holdCaret.ts).
    const caret = Math.min(Math.max(0, initial.caret ?? view.state.doc.length), view.state.doc.length)
    const top = initial.caret === undefined ? undefined : initial.caretTop
    view.dispatch({ selection: { anchor: caret }, scrollIntoView: top === undefined })
    view.focus()
    if (top !== undefined) releaseCaret = holdCaretAt(view, top, () => props.onCaretPlaced?.())
  }
  return {
    update,
    setHeight: (height: number | null) => {
      chosenHeight = height
      size()
      view.requestMeasure()
    },
    /** The selected text now, which a render may not have caught up with. */
    selection: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    focus: (at?: number) => {
      if (at !== undefined) {
        const anchor = Math.min(Math.max(0, at), view.state.doc.length)
        view.dispatch({ selection: { anchor }, scrollIntoView: true })
      }
      view.focus()
    },
    edit: (value: string, before: string) => {
      const current = view.state.doc.toString()
      // A restore response may arrive after more typing. Keep that newer edit.
      if (current !== before && current !== value) return
      // The store may already have echoed the restored text. Recreate only this local
      // undo boundary before the browser paints, without emitting an intermediate edit.
      if (current === value) replace(before)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: [Transaction.userEvent.of("input"), isolateHistory.of("full")]
      })
      view.focus()
    },
    finishComposition() {
      if (deferred !== null) {
        const value = deferred
        deferred = null
        replace(value)
      }
    },
    destroy: () => {
      pointerEvents.abort()
      releaseCaret()
      extensionVersion++
      language = "\0gone" // A mode still loading isn't applied to a destroyed view.
      unsubscribe()
      clearTimeout(fade)
      view.destroy()
    }
  }
}
