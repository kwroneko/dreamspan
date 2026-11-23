// A field of a library entry in its own workbench tab (fieldTab.ts): titled "<entry> · <field>",
// the field's box filling the tab with its scrollbar inside. It edits through the entry's one
// store on the page (sharedStore.ts), or the chat's it was opened from while that chat is open,
// so the field in its editor and here are the same text and draft. A chat's own note edits at the
// branch position its URL names, through the store of the note open there, if one is.
import type { RefId } from "@dreamspan/shared/library.ts"
import { Link, useLocation } from "@tanstack/react-router"
import { useEffect } from "react"
import { ErrorAlert } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { Alert } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { FieldTabEditor } from "./controls.tsx"
import { type FieldTabTarget, fieldTabKey, fieldTabName, fieldTabTarget } from "./fieldTab.ts"
import { ChatBoundEditor, Region, useLiveChatNoteStore } from "./PresetWorkspace.tsx"
import { EditorReadOnly } from "./readOnly.ts"
import { readOnlyRef, useSharedEditorStore } from "./sharedStore.ts"
import { type EditorStore, useEditorState, useLeaveGuard } from "./store.ts"

function FieldView({ target, supplied }: { target: FieldTabTarget; supplied?: EditorStore | undefined }) {
  const store = useSharedEditorStore(target.refId, supplied, target.chatNote)
  const state = useEditorState(store)
  useEffect(() => {
    if (store.snapshot === null) void store.load()
  }, [store])
  useLeaveGuard(store)
  const entry = state.snapshot?.ref.label ?? ""
  const title = fieldTabName(entry, target.label)
  useTitle(title)
  if (state.loadError?.tag === "NotFound")
    return (
      <Alert tone="warning">
        <p>
          This item was deleted or never existed ·{" "}
          <Tooltip label="Opens the library.">
            <Link to="/library" className="text-accent underline-offset-4 hover:underline">
              Library
            </Link>
          </Tooltip>
        </p>
      </Alert>
    )
  if (state.loadError)
    return (
      <ErrorAlert
        error={state.loadError}
        actions={
          <Button hint="Retries loading this field." variant="ghost" onClick={() => void store.load()}>
            Try again
          </Button>
        }
      />
    )
  if (state.snapshot === null) return <Loading label="Opening the field…" onRetry={() => void store.load()} />
  return (
    <EditorReadOnly value={store.readOnly}>
      <Region label={title} className="flex min-h-0 flex-1 flex-col">
        <CenterHeaderContent>
          <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
        </CenterHeaderContent>
        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
          <FieldTabEditor store={store} field={target.field} path={target.path} label={target.label} />
        </div>
      </Region>
    </EditorReadOnly>
  )
}

/** A chat's own note: the chat's store for it while the chat is open, so its panel shows the same text. */
function NoteFieldView({ target, url }: { target: FieldTabTarget; url: URL }) {
  const live = useLiveChatNoteStore(target.refId, target.chatNote)
  return (
    <FieldView key={`${fieldTabKey(url) ?? target.refId}\n${live ? "bound" : "own"}`} target={target} supplied={live} />
  )
}

export function FieldPage() {
  const href = useLocation({ select: (location) => location.href })
  const url = new URL(href, "http://tab.invalid")
  const target = fieldTabTarget(url)
  if (!target) return <Alert tone="warning">This link doesn't name a field.</Alert>
  const chat = url.searchParams.get("chat")
  if (target.chatNote) return <NoteFieldView target={target} url={url} />
  // Opened from a chat: its stores while it's open, so its panel shows the same text.
  if (chat && !readOnlyRef(target.refId))
    return (
      <ChatBoundEditor refId={target.refId as RefId} focus={undefined} chatId={chat} onClose={undefined}>
        {(bound) => <FieldView key={bound.store ? "bound" : "own"} target={target} supplied={bound.store} />}
      </ChatBoundEditor>
    )
  return <FieldView key={target.refId} target={target} />
}
