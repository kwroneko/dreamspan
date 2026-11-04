// A snippet's revisions (DESIGN §6.2): History beside its Save, as every editor has. Its text's
// own edit history is the control beside the box.
import type { Snippet } from "@rp/shared/snippetsApi.ts"
import { useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { useCaller } from "../editor/caller.ts"
import { RevisionsDialog } from "../editor/RevisionsDialog.tsx"
import { useEditorState, useText } from "../editor/store.ts"
import type { SnippetWorkspace } from "./workspace.ts"

export function SnippetHistory({ store, item }: { store: SnippetWorkspace; item: Snippet }) {
  const [open, setOpen] = useState(false)
  const call = useCaller()
  const editor = store.store(item.ref.id)
  const loaded = useEditorState(editor).snapshot !== null
  const typedTitle = useText(editor, ["title"])
  const name = (loaded ? typedTitle : item.title) || "Untitled snippet"
  return (
    <>
      <Button
        variant="ghost"
        className="h-8 px-2"
        aria-label={`History of ${name}`}
        hint="Its revisions, what changed in each, and restoring one. Typing alone makes none: Save does."
        onClick={() => setOpen(true)}
      >
        <Icon name="history" />
        History
      </Button>
      {open && <RevisionsDialog store={editor} call={call} title={`History: ${name}`} onClose={() => setOpen(false)} />}
    </>
  )
}
