// Explicit merges into library forks (DESIGN §4; ARCHITECTURE §14.6), registered as a plugin
// would: the notice in every editor, Undo merge in History, the family of a preset or lorebook
// beside History. The review computes its result with the shared registry's "library.merge"
// policy when one is registered there, else the default one the server workers register.
import { editorActions, editorNotices, revisionActions } from "../editor/editorSlots.ts"
import { panelEditorActions } from "../editor/panelActions.tsx"
import type { EditorStore } from "../editor/store.ts"
import { FamilyButton } from "./FamilyButton.tsx"
import { MergeNotice } from "./MergeNotice.tsx"
import { UndoMerge } from "./UndoMerge.tsx"

const family = (compact: boolean) =>
  function FamilyAction({ store }: { store: EditorStore }) {
    return <FamilyButton store={store} compact={compact} />
  }

export const register = () => [
  editorNotices.register({ id: "fork-merge.notice", order: 10, component: MergeNotice }),
  revisionActions.register({ id: "fork-merge.undo", order: 10, component: UndoMerge }),
  editorActions.register({ id: "fork-merge.family", order: 10, component: family(false) }),
  panelEditorActions.register({ id: "fork-merge.family", order: 25, component: family(true) })
]
