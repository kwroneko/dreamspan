import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent, compactHeaderControls } from "../../ui/CenterHeader.tsx"
import { DocumentSwitcher } from "../editor/DocumentSwitcher.tsx"
import { SNIPPET_FOCUS } from "../editor/workspaceViews.ts"
// A snippet in the large editor (owner, 2026-11-02): open in the chat's centre column while the
// side panel shows other text, to paste or send into it. It edits through the workspace's store
// for the snippet, the one its block in Snippets uses, so both show the same text, the same
// "edited" marker and the same Save. Over a chat it's the workspace's overlay (`editor`, `focus`
// in the URL); outside one, the snippet's library page with the same focus.
import { textField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useSyncExternalStore } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { WindowClose } from "../../ui/WindowClose.tsx"
import { copy } from "../chat/copy.ts"
import { TextField } from "../editor/controls.tsx"
import { SaveRevision } from "../editor/SaveRevision.tsx"
import { useEditorState, useLeaveGuard, useText } from "../editor/store.ts"
import { snippetTools } from "./slots.ts"
import type { SnippetWorkspace } from "./workspace.ts"
import { useSnippetEditorSurface } from "./index.tsx"

export function SnippetLarge({
  workspace,
  refId,
  onClose
}: {
  workspace: SnippetWorkspace
  refId: RefId
  onClose?: (() => void) | undefined
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.snapshot, workspace.snapshot)
  const store = workspace.store(refId)
  const editor = useEditorState(store)
  useLeaveGuard(store)
  const typedTitle = useText(store, ["title"])
  const typedContent = useText(store, ["content"])
  const item = state.items.find((it) => it.ref.id === refId)
  // While shown it's an expanded snippet, so text sent without a choice can land here.
  const surface = useSnippetEditorSurface(refId, editor.snapshot !== null)
  const flash = state.added?.refId === refId ? state.added : undefined
  // Deleted here (its Delete) or elsewhere: once listed and gone, the view closes.
  const listed = useRef(false)
  useEffect(() => {
    if (item) listed.current = true
    else if (listed.current) onClose?.()
  }, [item, onClose])
  // Opening it here uses it, as opening its block does.
  useEffect(() => {
    workspace.use(refId)
  }, [workspace, refId])
  const back = onClose ? (
    <Button hint="Returns to the chat." onClick={onClose}>
      Back to the chat
    </Button>
  ) : (
    <Tooltip label="Opens the library.">
      <Link to="/library" className="text-accent underline-offset-4 hover:underline">
        Library
      </Link>
    </Tooltip>
  )
  if (editor.loadError?.tag === "NotFound")
    return (
      <Alert tone="warning" actions={back}>
        <p>This snippet was deleted, or never existed.</p>
      </Alert>
    )
  if (editor.loadError) return <ErrorAlert error={editor.loadError} actions={back} />
  if (editor.snapshot === null) return <Loading label="Opening the snippet…" onRetry={() => void store.load()} />
  const title = typedTitle || "Untitled snippet"
  const content = typedContent ?? ""
  return (
    <section aria-label={`Snippet ${title}`} className="flex min-w-0 flex-col gap-3">
      {!onClose && (
        <Tooltip label="Returns to the library.">
          <Link to="/library" className="text-sm text-muted underline-offset-4 hover:text-text hover:underline">
            ← Library
          </Link>
        </Tooltip>
      )}
      <CenterHeaderContent>
        <header
          className={`flex min-w-0 items-center gap-2 sm:[&_[data-rename-pencil]]:size-8! ${compactHeaderControls}`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <InlineRename
              place={`snippet-title:large:${refId}`}
              value={typedTitle}
              label={title}
              className="min-w-0"
              onRename={(next) => {
                store.setText(["title"], next)
                void store.save(textField(["title"]))
              }}
            >
              <h1 aria-label={title} className="min-w-0 text-xl font-semibold [overflow-wrap:anywhere]">
                <DocumentSwitcher
                  refId={refId}
                  label={title}
                  kind="note"
                  subject="snippet"
                  focus={SNIPPET_FOCUS}
                  items={state.items.map((item) => ({
                    value: item.ref.id,
                    label: item.title || item.ref.label,
                    updatedAt: item.ref.updatedAt
                  }))}
                  create={{
                    label: "New snippet",
                    hint: `${state.chatId === null ? "An empty snippet for all chats" : "An empty snippet for this chat, every branch of it"}, opened in this editor`,
                    run: async () => (await workspace.create())?.ref.id ?? null
                  }}
                />
              </h1>
            </InlineRename>
          </div>
          {/* One row of buttons, one gap between them. */}
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              label={`Copy ${title}`}
              hint="Copies its text, to paste anywhere"
              icon="copy"
              disabled={content === ""}
              onClick={() => void copy(content, "Snippet")}
            />
            <SaveRevision store={store} />
            {onClose && <WindowClose onClick={onClose} />}
          </div>
        </header>
      </CenterHeaderContent>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {item && (
          <Switch
            checked={item.global}
            disabled={item.global && state.chatId === null}
            onCheckedChange={(global) => void workspace.setGlobal(refId, global)}
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
        )}
        {item && (
          <span className="flex flex-wrap items-center gap-1">
            <SlotOutlet slot={snippetTools} props={{ store: workspace, item }} />
          </span>
        )}
      </div>
      <div {...surface}>
        <TextField
          store={store}
          path={["content"]}
          label={`Text of ${title}`}
          labelHidden
          rows={Math.max(16, content.split("\n").length)}
          source="snippet"
          flash={flash}
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </section>
  )
}
