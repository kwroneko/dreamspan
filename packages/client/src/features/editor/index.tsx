import { cardEditorSections } from "./cardSections.ts"
import { EmbeddedLorebook } from "./EmbeddedLorebook.tsx"
import { editorTextFields } from "./fields.ts"
import { lorebookFields } from "./lorebookFields.ts"
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
  cardEditorSections.register({ id: "card.embedded-lorebook", order: 100, component: EmbeddedLorebook })
  editorTextFields.register({ id: "card.embedded-lorebook", kind: "card", fields: lorebookFields })
  routes.register({ id: "library.editor", parent: "app", path: "/library/$refId", component: LazyEditorPage })
}
