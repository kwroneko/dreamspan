import { cardEditorSections } from "./cardSections.ts"
import { EmbeddedLorebook } from "./EmbeddedLorebook.tsx"
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
  routes.register({ id: "library.editor", parent: "app", path: "/library/$refId", component: LazyEditorPage })
}
