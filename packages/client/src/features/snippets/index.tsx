// Snippets (DESIGN §4.1; owner, 2026-11-01): text kept beside your chats, never sent by itself.
// Each is a block as a note is (ui/Block): its name renamed in place, Copy, and its text, saved as
// it's typed with its edit history, Save cutting a revision; for this chat (every branch of it)
// or all chats, by a switch. A note can show one; any editor sends its text to one.
import type { RefId } from "@rp/shared/library.ts"
import { textField } from "@rp/shared/editing.ts"
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { appTools } from "../shell.tsx"
import { useSession } from "../../session.ts"
import { useCaller } from "../editor/caller.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import { chatPanels, lazyPanel } from "../chat/panels.tsx"
import { chatSurfaceProviders, type ChatSurfaceProps } from "../chat/presentation.tsx"
import { textActions } from "../../textActions.tsx"
import { copy } from "../chat/copy.ts"
import { Block, BlockBody, BlockHeader, BlockToggle, ExpandCollapseAll } from "../../ui/Block.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { useOpenBlocks } from "../../ui/openBlocks.ts"
import { Sheet } from "../../ui/Sheet.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { TextField } from "../editor/controls.tsx"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { useEditorState, useLeaveGuard, useText } from "../editor/store.ts"
import { DeleteSnippet } from "./delete.tsx"
import { SnippetHistory } from "./history.tsx"
import { snippetTools } from "./slots.ts"
import { SnippetWorkspace } from "./workspace.ts"

let workspace: SnippetWorkspace | null = null
function Scope({ session, onOpenPanel, children }: ChatSurfaceProps) {
  useEffect(() => {
    workspace?.setChat(session.id)
    return () => workspace?.setChat(null)
  }, [session.id])
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
  )
}
function SnippetsPanel() {
  return workspace ? <Workspace store={workspace} /> : <p>Opening snippets…</p>
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? ""

/** One snippet as a block: its header always shown, its text when open. */
function SnippetBlock({
  workspace,
  item,
  open,
  onOpenChange
}: {
  workspace: SnippetWorkspace
  item: Snippet
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.snapshot, workspace.snapshot)
  const store = workspace.store(item.ref.id)
  const loaded = useEditorState(store).snapshot !== null
  useLeaveGuard(store)
  const typedTitle = useText(store, ["title"])
  const typedContent = useText(store, ["content"])
  const title = (loaded ? typedTitle : item.title) || "Untitled snippet"
  const content = loaded ? typedContent : item.content
  const scope = item.global ? "All chats" : "This chat"
  const detail = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
      <span>{scope}</span>
      {!open && firstLine(content) !== "" && (
        <span className="line-clamp-1 min-w-0 [overflow-wrap:anywhere]">· {firstLine(content)}</span>
      )}
    </span>
  )
  const toggle = (
    <BlockToggle
      open={open}
      onToggle={() => {
        if (!open) workspace.select(item.ref.id)
        onOpenChange(!open)
      }}
      label={title}
      name={title}
      detail={detail}
      hint={open ? "Hide the snippet's text" : "Show the snippet's text"}
    />
  )
  return (
    <li>
      <Block aria-label={`Snippet ${title}`} className="bg-canvas">
        <BlockHeader>
          {loaded ? (
            <InlineRename
              value={typedTitle}
              label={title}
              className="min-w-0 flex-1"
              onRename={(next) => {
                store.setText(["title"], next)
                void store.save(textField(["title"]))
              }}
            >
              {toggle}
            </InlineRename>
          ) : (
            <span className="flex min-w-0 flex-1">{toggle}</span>
          )}
          <IconButton
            label={`Copy ${title}`}
            hint="Copies its text, to paste anywhere"
            icon="copy"
            disabled={content === ""}
            onClick={() => void copy(content, "Snippet")}
          />
        </BlockHeader>
        {open && (
          <>
            <BlockBody>
              {loaded ? (
                <div
                  onFocus={() => {
                    if (state.selected !== item.ref.id) workspace.select(item.ref.id)
                  }}
                >
                  <TextField
                    store={store}
                    path={["content"]}
                    label={`Text of ${title}`}
                    labelHidden
                    rows={Math.min(10, Math.max(3, content.split("\n").length))}
                    source="snippet"
                  />
                </div>
              ) : (
                <p className="text-sm text-muted">Loading the snippet…</p>
              )}
            </BlockBody>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-2 py-1.5">
              <Switch
                checked={item.global}
                disabled={item.global && state.chatId === null}
                onCheckedChange={(global) => void workspace.setGlobal(item.ref.id, global)}
                hint={
                  item.global
                    ? state.chatId === null
                      ? "In every chat. Open a chat to make it that chat's own."
                      : "In every chat. Switch it off to keep it only in this chat, every branch of it."
                    : "Only in this chat, every branch of it. Switch it on to have it in every chat."
                }
              >
                All chats
              </Switch>
              {loaded && <SaveRevision store={store} compact />}
              <span className="flex flex-wrap items-center gap-1">
                <SlotOutlet slot={snippetTools} props={{ store: workspace, item }} />
              </span>
            </div>
          </>
        )}
      </Block>
    </li>
  )
}

function Workspace({ store }: { store: SnippetWorkspace }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const user = useSession().user.id
  const [query, setQuery] = useState("")
  const blocks = useOpenBlocks(`rp.snippetBlocks.${user}`, state.items.length)
  const shown = state.items.filter((i) =>
    `${i.title} ${i.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  // A snippet just made or sent to opens, and shows.
  useEffect(() => {
    if (state.selected === null || state.reveal === 0) return
    blocks.setOpen(state.selected, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.reveal])
  const ids = shown.map((item) => item.ref.id)
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Snippets">
      <p className="text-sm text-muted">
        Text you keep beside your chats: lines to reuse, passages from a swipe, ideas. A snippet is never sent to the
        model by itself; a note can show one (Add note, then Pick a shared note). Copy one to paste it anywhere, and add
        to the one open last from any editor with Send text to snippet.
      </p>
      <div className="flex max-w-controls items-end gap-2">
        <Field label="Search snippets" className="min-w-0 flex-1">
          <Input value={query} onChange={(e) => setQuery(e.currentTarget.value)} placeholder="Name or text" />
        </Field>
        <Button
          hint={
            state.chatId === null
              ? "An empty snippet for all chats"
              : "An empty snippet for this chat, every branch of it; its switch makes it one for all chats"
          }
          onClick={() => void store.create()}
        >
          New snippet
        </Button>
      </div>
      {shown.length > 0 && (
        <ExpandCollapseAll
          compact
          anyOpen={ids.some((id) => blocks.isOpen(id))}
          allOpen={ids.every((id) => blocks.isOpen(id))}
          expandHint="Show every snippet's text"
          collapseHint="Fold every snippet to its name"
          onExpand={() => blocks.setAll(ids, true)}
          onCollapse={() => blocks.setAll(ids, false)}
        />
      )}
      {state.items.length === 0 ? (
        <p className="text-sm text-muted">No snippets yet. Make one, or send text here from an editor.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">No snippet has that in its name or text.</p>
      ) : (
        <ul aria-label="Snippet list" className="flex flex-col gap-1.5">
          {shown.map((item) => (
            <SnippetBlock
              key={item.ref.id}
              workspace={store}
              item={item}
              open={blocks.isOpen(item.ref.id)}
              onOpenChange={(open) => blocks.setOpen(item.ref.id as RefId, open)}
            />
          ))}
        </ul>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </section>
  )
}
const canSend = () => chatPanels.get("snippets") !== undefined
export const register = () => [
  snippetTools.register({ id: "snippets.history", order: 10, component: SnippetHistory }),
  snippetTools.register({ id: "snippets.delete", order: 90, component: DeleteSnippet }),
  appTools.register({ id: "snippets.tools", order: 20, component: Tools }),
  chatSurfaceProviders.register({ id: "snippets.scope", order: 20, component: Scope }),
  chatPanels.register({
    id: "snippets",
    label: "Snippets",
    description: "Text kept beside your chats, never sent by itself: copy it, or send text here from any editor.",
    icon: "snippet",
    order: 75,
    component: lazyPanel(() => Promise.resolve({ default: SnippetsPanel }), "snippets"),
    // Snippets are kept beside every chat, a pending one too.
    pending: SnippetsPanel
  }),
  // Every editor's bar: its whole text, and its selection while there is one. A snippet's
  // own editor doesn't offer them: they would append it to itself.
  textActions.register({
    id: "snippets.send-text",
    label: "Send text to snippet",
    shortLabel: "Text to snippet",
    description: "Adds this editor's whole text to the end of the snippet open last in Snippets, or to a new one.",
    icon: "snippet",
    editor: "text",
    available: ({ text, source }) => source !== "snippet" && text.trim().length > 0 && canSend(),
    run: ({ text }) => void workspace?.send(text)
  }),
  textActions.register({
    id: "snippets.send",
    label: "Send selection to snippet",
    shortLabel: "Selection to snippet",
    description: "Adds the selected text to the end of the snippet open last in Snippets, or to a new one.",
    icon: "snippet",
    editor: "selection",
    shortcut: "s",
    available: ({ text, source }) => source !== "snippet" && text.length > 0 && canSend(),
    run: ({ text }) => void workspace?.send(text)
  }),
  textActions.register({
    id: "snippets.open",
    label: "Open in Snippets",
    description: "Opens it in the Snippets panel, beside the chat.",
    available: ({ source, refId }) => source === "note" && refId !== undefined,
    run: ({ refId }) => {
      if (refId) workspace?.select(refId as RefId)
      workspace?.open()
    }
  })
]
