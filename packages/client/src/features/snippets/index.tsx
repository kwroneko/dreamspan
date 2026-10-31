import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { appTools } from "../shell.tsx"
import { useSession } from "../../session.ts"
import { useCaller } from "../editor/caller.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import { chatPanels, lazyPanel } from "../chat/panels.tsx"
import { chatSurfaceProviders, type ChatSurfaceProps } from "../chat/presentation.tsx"
import { textActions, insertText, hasTextDestination } from "../../textActions.tsx"
import { CodeEditor } from "../../ui/CodeEditor.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Sheet } from "../../ui/Sheet.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { DeleteSnippet } from "./delete.tsx"
import { SnippetHistory } from "./history.tsx"
import { snippetTools } from "./slots.ts"
import { SnippetWorkspace } from "./workspace.ts"

let workspace: SnippetWorkspace | null = null
function Scope({ session, view, onOpenPanel, children }: ChatSurfaceProps) {
  const fork = view.forkId
  useEffect(() => {
    workspace?.setScope({ chatId: session.id, forkId: fork })
    return () => workspace?.setScope({ chatId: null, forkId: null })
  }, [session.id, fork])
  useEffect(() => {
    workspace?.setOpener(() => onOpenPanel("snippets"))
    return () => workspace?.setOpener(null)
  }, [onOpenPanel])
  return children
}
function Tools() {
  const call = useCaller()
  const user = useSession().user.id
  const store = useMemo(() => new SnippetWorkspace(call, user), [call, user])
  useEffect(() => {
    workspace = store
    void store.refresh()
    const stop = onLibraryChange(() => void store.refresh())
    return () => {
      stop()
      if (workspace === store) workspace = null
    }
  }, [store])
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  return (
    <>
      <Sheet
        open={state.floating}
        onOpenChange={(open) => {
          if (!open) store.close()
        }}
        title="Snippets"
      >
        <div className="min-h-0 overflow-y-auto p-4">
          <Workspace store={store} />
        </div>
      </Sheet>
    </>
  )
}
function SnippetsPanel() {
  return workspace ? <Workspace store={workspace} /> : <p>Opening snippets…</p>
}
function Workspace({ store }: { store: SnippetWorkspace }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [query, setQuery] = useState("")
  const [selection, setSelection] = useState("")
  const [notice, setNotice] = useState("")
  const actions = useSyncExternalStore(textActions.subscribe, textActions.snapshot, textActions.snapshot)
  const insertAction = actions.entries.find((action) => action.id === "snippets.insert")
  const item = state.items.find((i) => i.ref.id === state.selected)
  const insert = () => {
    if (!item) return
    const action = textActions.get("snippets.insert")
    const context = { text: selection || item.content, source: "snippet" as const }
    if (action?.available(context)) action.run(context)
    else setNotice("Focus a field first, then return here to insert at its cursor.")
  }
  return (
    <section data-text-tool className="flex min-w-0 flex-col gap-3" aria-label="Snippet workspace">
      <p className="text-sm text-muted">
        Keep text beside your chat. Select text anywhere and press Ctrl+Shift+S to send it here.
      </p>
      <div className="flex items-end gap-2">
        <Field label="Search snippets" className="min-w-0 flex-1">
          <Input value={query} onChange={(e) => setQuery(e.currentTarget.value)} placeholder="Name or text" />
        </Field>
        <Button
          onClick={() => {
            setSelection("")
            void store.create()
          }}
        >
          New snippet
        </Button>
      </div>
      <ul
        aria-label="Snippets"
        className="max-h-44 overflow-y-auto rounded-md border border-border divide-y divide-border"
      >
        {state.items
          .filter((i) => `${i.title} ${i.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .map((snippet) => (
            <li key={snippet.ref.id}>
              <button
                type="button"
                aria-pressed={snippet.ref.id === state.selected}
                className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-surface-raised aria-pressed:bg-surface-raised"
                onClick={() => {
                  store.select(snippet.ref.id)
                  setSelection("")
                }}
              >
                <span className="text-sm font-medium">{snippet.title || "Untitled snippet"}</span>
                <span className="line-clamp-1 text-xs text-muted">
                  {snippet.global ? "Global" : "This chat and future forks"} · {snippet.content || "Empty"}
                </span>
              </button>
            </li>
          ))}
      </ul>
      {state.items.length === 0 && (
        <p className="text-sm text-muted">No snippets yet. Create one or send selected text here.</p>
      )}
      {item && (
        <fieldset className="flex min-w-0 flex-col gap-3" key={item.ref.id} disabled={state.deleting === item.ref.id}>
          <Field label="Snippet name">
            <Input value={item.title} onChange={(e) => store.change(item.ref.id, { title: e.currentTarget.value })} />
          </Field>
          <CodeEditor
            label="Snippet text"
            value={item.content}
            base={item.content}
            rows={10}
            readOnly={state.deleting === item.ref.id}
            onChange={(content) => store.change(item.ref.id, { content })}
            onSelectionChange={setSelection}
          />
          <div className="flex flex-wrap items-center gap-2">
            {insertAction && (
              <Button variant="primary" onMouseDown={(e) => e.preventDefault()} onClick={insert}>
                {insertAction.label}
                {selection ? " selection" : ""}
              </Button>
            )}
            {!item.global && <Button onClick={() => void store.makeGlobal(item.ref.id)}>Make global</Button>}
            <SlotOutlet slot={snippetTools} props={{ store, item }} />
            <span role="status" className="text-xs text-muted">
              {state.error
                ? "Not saved"
                : state.deleting === item.ref.id
                  ? "Deleting…"
                  : state.saving
                    ? "Saving…"
                    : "Saved continuously"}
            </span>
          </div>
          {state.error && (
            <>
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
              <Button onClick={() => void store.create(item.content)}>Save as new snippet</Button>
            </>
          )}
        </fieldset>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
      {!item && state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </section>
  )
}
export const register = () => [
  snippetTools.register({ id: "snippets.history", order: 10, component: SnippetHistory }),
  snippetTools.register({ id: "snippets.delete", order: 90, component: DeleteSnippet }),
  appTools.register({ id: "snippets.tools", order: 20, component: Tools }),
  chatSurfaceProviders.register({ id: "snippets.scope", order: 20, component: Scope }),
  chatPanels.register({
    id: "snippets",
    label: "Snippets",
    icon: "snippet",
    order: 75,
    component: lazyPanel(() => Promise.resolve({ default: SnippetsPanel }), "snippets")
  }),
  textActions.register({
    id: "snippets.send",
    label: "Send to snippet",
    shortcut: "s",
    available: ({ text }) => text.length > 0 && chatPanels.get("snippets") !== undefined,
    run: ({ text }) => workspace?.send(text)
  }),
  textActions.register({
    id: "snippets.open",
    label: "Open in Snippets",
    available: ({ source, refId }) => source === "note" && refId !== undefined,
    run: ({ refId }) => {
      if (refId) workspace?.select(refId as import("@rp/shared/library.ts").RefId)
      workspace?.open()
    }
  }),
  textActions.register({
    id: "snippets.insert",
    label: "Insert",
    available: ({ text, source }) => source === "snippet" && text.length > 0 && hasTextDestination(),
    run: ({ text }) => {
      insertText(text)
    }
  })
]
