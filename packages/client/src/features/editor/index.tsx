import { registerUserDraftNotices } from "./userDraft.tsx"
import { libraryActions } from "../library/slots.ts"
import { NewCardButton } from "./NewCard.tsx"
import { NewPresetButton } from "./NewPreset.tsx"
import { appTools } from "../shell.tsx"
import { CardSavedHost } from "./CardSavedHost.tsx"
import { cardEditorSections, lorebookEditorSections } from "./cardSections.ts"
import { EmbeddedLorebook } from "./EmbeddedLorebook.tsx"
import { EndOfRequest } from "./EndOfRequest.tsx"
import { presetEditorSections } from "./presetSections.ts"
import { editorTextFields } from "./fields.ts"
import { lorebookFields, standaloneLorebookFields } from "./lorebookFields.ts"
import { LorebookUse, StandaloneLorebook } from "./StandaloneLorebook.tsx"
import { lazy, Suspense } from "react"
import { routes } from "../../routes.tsx"
import { Loading } from "../../ui/Spinner.tsx"

// The editors load with the first entry opened.
const EditorPage = lazy(() => import("./EditorPage.tsx").then((module) => ({ default: module.EditorPage })))

function LazyEditorPage() {
  return (
    <Suspense fallback={<Loading label="Opening the editor…" />}>
      <EditorPage />
    </Suspense>
  )
}

export const register = () => {
  registerUserDraftNotices()
  libraryActions.register({ id: "editor.new-card", order: 10, component: NewCardButton })
  libraryActions.register({ id: "editor.new-preset", order: 20, component: NewPresetButton })
  appTools.register({ id: "editor.card-saved", order: 200, component: CardSavedHost })
  cardEditorSections.register({ id: "card.embedded-lorebook", order: 100, component: EmbeddedLorebook })
  presetEditorSections.register({ id: "preset.end-of-request", order: 100, component: EndOfRequest })
  editorTextFields.register({ id: "card.embedded-lorebook", kind: "card", fields: lorebookFields })
  lorebookEditorSections.register({ id: "lorebook.use", order: 10, component: LorebookUse })
  lorebookEditorSections.register({ id: "lorebook.entries", order: 100, component: StandaloneLorebook })
  editorTextFields.register({ id: "lorebook.entries", kind: "lorebook", fields: standaloneLorebookFields })
  routes.register({ id: "library.editor", parent: "app", path: "/library/$refId", component: LazyEditorPage })
}
