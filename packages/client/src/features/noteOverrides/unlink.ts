// Unlinking a note from what it replaces (DESIGN §4.2: one note per target; a second offers to
// unlink the other): its `replaces` and `own_position` go, through its editor store, so an open
// editor of it shows the change.
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import type { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import type { EditorStore } from "../editor/store.ts"
import type { ReplaceChat } from "./chat.tsx"

type Workspace = NonNullable<ReturnType<typeof usePresetWorkspace>>

/** A listed note's store in the chat's workspace: a chat's own note at the branch shown. */
const noteStore = (workspace: Workspace, chat: ReplaceChat, note: ChatNote): EditorStore =>
  workspace.store(note.ref.id, note.card === null ? chat.position : undefined)

const unlink = async (store: EditorStore) => {
  if (store.snapshot === null) await store.load()
  store.setValue(["replaces"], undefined)
  store.setValue(["own_position"], undefined)
  // Saved at once, as a relink is (NoteList's `relink`): the next reply's estimate, which reads
  // saved notes, must stop naming it before the new note can take its place.
  await store.flush()
  if (store.state().dirty > 0) await store.commit(null)
}

export const unlinkNote = (workspace: Workspace, chat: ReplaceChat, note: ChatNote) =>
  unlink(noteStore(workspace, chat, note))
