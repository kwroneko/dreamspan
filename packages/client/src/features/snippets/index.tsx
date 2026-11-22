// Snippets (DESIGN §4.1; owner, 2026-11-01): text kept beside your chats, never sent by itself.
// Each is a block as a note is (ui/Block): its name renamed in place, Copy, and its text, saved as
// it's typed with its edit history, Save cutting a revision; for this chat (every branch of it)
// or all chats, by a switch. A note can show one; any editor sends its text to one.
import type { RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import type { Snippet } from "@dreamspan/shared/snippetsApi.ts"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { appTools } from "../shell.tsx"
import { useSession } from "../../session.ts"
import { useCaller } from "../editor/caller.ts"
import { onLibraryChange } from "../../libraryChanges.ts"
import { chatPanels, lazyPanel } from "../chat/panels.tsx"
import { chatSurfaceProviders, type ChatSurfaceProps } from "../chat/presentation.tsx"
import { type TextActionContext, textActions } from "../../textActions.tsx"
import { copy } from "../chat/copy.ts"
import { Block, BlockBody, BlockHeader, BlockToggle, ExpandCollapseAll } from "../../ui/Block.tsx"
import { DismissibleInfo } from "../../ui/DismissibleInfo.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { useOpenBlocks } from "../../ui/openBlocks.ts"
import { Sheet } from "../../ui/Sheet.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { TextField } from "../editor/controls.tsx"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { useEditorState, useLeaveGuard, useText } from "../editor/store.ts"
import { DeleteSnippet } from "./delete.tsx"
import { SnippetHistory } from "./history.tsx"
import { snippetTools } from "./slots.ts"
import { SnippetWorkspace } from "./workspace.ts"
import { useNavigate } from "@tanstack/react-router"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { SNIPPET_FOCUS, workspaceViews } from "../editor/workspaceViews.ts"
import { SnippetLarge } from "./SnippetLarge.tsx"

let workspace: SnippetWorkspace | null = null
/** Told when the workspace is made or goes, for a view that may render before it (a reload). */
const workspaceListeners = new Set<() => void>()
const setWorkspace = (next: SnippetWorkspace | null) => {
  workspace = next
  for (const listener of workspaceListeners) listener()
}
const useCurrentWorkspace = () =>
  useSyncExternalStore(
    (listener) => {
      workspaceListeners.add(listener)
      return () => workspaceListeners.delete(listener)
    },
    () => workspace
  )
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
    setWorkspace(store)
    void store.refresh()
    const stop = onLibraryChange(() => void store.refresh())
    return () => {
      stop()
      if (workspace === store) setWorkspace(null)
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

/**
 * A snippet's editor, wherever it shows (the Snippets panel or sheet, or any other surface): while
 * `shown`, it's expanded and so can be where Send text to snippet goes, and a click or typing in it
 * makes it the target (`SnippetWorkspace.target`). Spread the result on the element around the editor.
 * @public For other snippet editor surfaces (a large editor in the main column).
 */
export function useSnippetEditorSurface(refId: RefId, shown: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!shown || !ref.current || !workspace) return
    return workspace.registerEditor(ref.current, refId)
  }, [shown, refId])
  const use = () => workspace?.use(refId)
  return { ref, onFocus: use, onPointerDown: use }
}

const targetExplanation = 'This snippet is currently the default destination for "Send text to snippet" actions.'
const explanation =
  "Text you keep beside your chats: lines to reuse, passages from a swipe, ideas. A snippet is never sent to the model by itself; a note can show one (Pick a shared note). Copy one to paste it anywhere, and add text to one from any editor with Send text to snippet: it goes to the open snippet marked with a dot in its corner."

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? ""

/**
 * The large editor for a snippet (owner, 2026-11-02): over the chat, the workspace's overlay in
 * the centre column; outside one (the floating sheet), the snippet's library page.
 */
function useOpenLarge(refId: RefId) {
  const chat = usePresetWorkspace()
  const navigate = useNavigate()
  return chat
    ? {
        hint: "Opens the snippet over the chat, where it stays while the side panel changes",
        open: () => chat.open(refId, SNIPPET_FOCUS)
      }
    : {
        hint: "Opens the snippet on its own page, in a bigger editor",
        open: () => {
          workspace?.close()
          void navigate({ to: "/library/$refId", params: { refId }, search: { focus: SNIPPET_FOCUS } })
        }
      }
}

function SnippetLargeView({ refId, onClose }: { refId: RefId; onClose?: (() => void) | undefined }) {
  const current = useCurrentWorkspace()
  return current ? <SnippetLarge workspace={current} refId={refId} onClose={onClose} /> : <p>Opening snippets…</p>
}

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
  const shown = open && loaded
  const surface = useSnippetEditorSurface(item.ref.id, shown)
  // Read from the state, so it's read again as editors come and go and the target moves.
  const target = shown && workspace.target(state) === item.ref.id
  const flash = state.added?.refId === item.ref.id ? state.added : undefined
  const large = useOpenLarge(item.ref.id)
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
      <Block
        aria-label={`Snippet ${title}`}
        aria-description={target ? targetExplanation : undefined}
        className="relative bg-canvas"
      >
        {target && (
          <Tooltip label={targetExplanation}>
            <span
              data-snippet-target
              data-layout-audit-ignore="overlap: The target badge intentionally straddles the card corner border"
              className="absolute -top-1.5 -left-1.5 size-3 cursor-default rounded-full bg-accent"
            />
          </Tooltip>
        )}
        <BlockHeader>
          {loaded ? (
            <InlineRename
              place={`snippet-title:${item.ref.id}`}
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
          <IconButton
            label={`Open ${title} in the large editor`}
            hint={large.hint}
            icon="expand"
            onClick={large.open}
          />
        </BlockHeader>
        {open && (
          <>
            <BlockBody>
              {loaded ? (
                <div {...surface}>
                  <TextField
                    store={store}
                    path={["content"]}
                    label={`Text of ${title}`}
                    labelHidden
                    rows={Math.min(10, Math.max(3, content.split("\n").length))}
                    source="snippet"
                    flash={flash}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted">Loading the snippet…</p>
              )}
            </BlockBody>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-2 py-2">
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
              {loaded && <SaveRevision store={store} />}
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
  const [query, setQuery] = useState("")
  const blocks = useOpenBlocks("snippetsOpen", state.items.length)
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
      <DismissibleInfo id="snippets.intro" text={explanation}>
        {(help) => (
          <div className="flex max-w-controls items-end gap-2">
            <Field label="Search snippets" about={help} className="min-w-0 flex-1">
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
        )}
      </DismissibleInfo>
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
/** A phone, or a touch screen: there, the menu always opens, to choose where the text goes. */
const choosesAlways = () =>
  typeof matchMedia !== "undefined" && matchMedia("(max-width: 639.98px), (pointer: coarse)").matches
/** One click adds to the snippet open on screen; with none, or on a phone, the menu opens. */
const sendOrChoose = ({ text }: TextActionContext) => {
  const target = workspace?.target() ?? null
  if (workspace === null || target === null || choosesAlways()) return "choose" as const
  void workspace.append(target, text, "target")
}
const sendHint =
  (whole: boolean) =>
  (_context: TextActionContext): string => {
    const target = workspace?.target() ?? null
    const what = whole ? "this text" : "the selected text"
    return target === null || choosesAlways()
      ? `Choose a snippet to add ${what} to.`
      : `Adds ${what} to “${workspace?.titleOf(target) ?? ""}”. Right-click to choose a different snippet.`
  }
/** The send menu: the snippets, the one picked last first, then a new one. */
function SnippetChoices({ context, done }: { context: TextActionContext; done: () => void }) {
  const store = workspace
  const state = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.snapshot ?? (() => null),
    store?.snapshot ?? (() => null)
  )
  if (store === null || state === null) return null
  return (
    <>
      {store.choices(state).map((item) => (
        <MenuItem
          key={item.ref.id}
          icon="snippet"
          description={`Adds the text to the end of “${store.titleOf(item.ref.id)}”.`}
          onClick={() => {
            done()
            void store.append(item.ref.id, context.text, "chosen")
          }}
        >
          {store.titleOf(item.ref.id)}
        </MenuItem>
      ))}
      {state.items.length > 0 && <MenuSeparator />}
      <MenuItem
        icon="plus"
        description={
          state.chatId === null
            ? "Makes a snippet for all chats with this text."
            : "Makes a snippet for this chat with this text."
        }
        onClick={() => {
          done()
          void store.appendNew(context.text)
        }}
      >
        New snippet
      </MenuItem>
    </>
  )
}
export const register = () => [
  snippetTools.register({ id: "snippets.history", order: 10, component: SnippetHistory }),
  snippetTools.register({ id: "snippets.delete", order: 90, component: DeleteSnippet }),
  appTools.register({ id: "snippets.tools", order: 20, component: Tools }),
  workspaceViews.register({ id: SNIPPET_FOCUS, label: "Snippet editor", page: true, component: SnippetLargeView }),
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
    description: sendHint(true),
    icon: "snippet",
    editor: "text",
    applies: ({ source }) => source !== "snippet",
    unavailable: ({ text }) => (text.trim() === "" ? "No text to send yet." : "The Snippets panel is unavailable."),
    available: ({ text, source }) => source !== "snippet" && text.trim().length > 0 && canSend(),
    run: sendOrChoose,
    choices: SnippetChoices
  }),
  textActions.register({
    id: "snippets.send",
    label: "Send selection to snippet",
    shortLabel: "Selection to snippet",
    description: sendHint(false),
    icon: "snippetSelection",
    editor: "selection",
    shortcut: "s",
    available: ({ text, source }) => source !== "snippet" && text.length > 0 && canSend(),
    run: sendOrChoose,
    choices: SnippetChoices
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
