import { registerTextTarget } from "./textTargets.ts"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { Compartment, EditorState, Transaction } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { useEffect, useLayoutEffect, useRef } from "react"
import type { CodeEditorProps } from "./CodeEditor.tsx"
import { changeGutter, comparisonBase, lineChanges } from "./codeChanges.ts"
import { proseTheme } from "./codeTheme.ts"

/** One persistent view: controlled echoes never reset selection or undo history. */
export default function CodeEditorView(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const controller = useRef<ReturnType<typeof mountEditor> | null>(null)
  useLayoutEffect(() => {
    const mounted = mountEditor(host.current!, props)
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
      ref={host}
      className="min-w-0 overflow-hidden rounded-md border border-border bg-surface shadow-xs focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/40"
    />
  )
}

function mountEditor(host: HTMLElement, initial: CodeEditorProps) {
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
        options.of(attributes()),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main
            props.onSelectionChange?.(update.state.sliceDoc(range.from, range.to))
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
  const unregister = registerTextTarget(host, () => {
    const range = view.state.selection.main
    return {
      text: view.state.sliceDoc(range.from, range.to),
      editable: !props.readOnly,
      insert: (text) => {
        if (!host.isConnected || props.readOnly) return
        const target = view.state.selection.main
        view.dispatch({
          changes: { from: target.from, to: target.to, insert: text },
          selection: { anchor: target.from + text.length },
          userEvent: "input"
        })
        view.focus()
      }
    }
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
  let base: string | null = null
  const update = (next: CodeEditorProps) => {
    const oldProps = props
    props = next
    host.style.setProperty("--editor-font", next.mono ? "var(--font-mono)" : "var(--font-sans)")
    host.style.setProperty("--editor-max-height", next.fullHeight ? "none" : "min(60vh, 32rem)")
    host.style.setProperty("--editor-min-height", `${Math.min(next.rows ?? 4, 10) * 1.6}em`)
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
      view.focus()
      requestAnimationFrame(() => {
        if (!host.isConnected) return
        view.requestMeasure({
          read: () => view.coordsAtPos(anchor)?.top,
          write: (top) => {
            if (top !== undefined && host.isConnected) props.onRevealSelection?.(host, top)
          }
        })
      })
    }
    if (base !== next.base) {
      base = next.base
      view.dispatch({ effects: comparisonBase.of(base) })
    }
    if (oldProps.readOnly !== next.readOnly || oldProps.label !== next.label || oldProps.mono !== next.mono)
      view.dispatch({ effects: options.reconfigure(attributes()) })
  }
  update(initial)
  if (initial.autoFocus) view.focus()
  return {
    update,
    finishComposition() {
      if (deferred !== null) {
        const value = deferred
        deferred = null
        replace(value)
      }
    },
    destroy: () => {
      unregister()
      view.destroy()
    }
  }
}
