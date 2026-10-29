import { libraryActions } from "../library/slots.ts"
import { NewCardButton } from "./NewCard.tsx"
import { NewPresetButton } from "./NewPreset.tsx"
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
  libraryActions.register({ id: "editor.new-card", order: 10, component: NewCardButton })
  libraryActions.register({ id: "editor.new-preset", order: 20, component: NewPresetButton })
  routes.register({ id: "library.editor", parent: "app", path: "/library/$refId", component: LazyEditorPage })
}
