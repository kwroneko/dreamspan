import { lazy, Suspense } from "react"
import { cardEditorSections } from "../editor/cardSections.ts"
import type { CardTabProps } from "../editor/cardTabs.ts"

const Gallery = lazy(() => import("./Gallery.tsx").then((m) => ({ default: m.Gallery })))
function Section(props: Pick<CardTabProps, "store" | "call">) {
  return (
    <Suspense fallback={null}>
      <Gallery {...props} />
    </Suspense>
  )
}
export const register = () => cardEditorSections.register({ id: "card.gallery", order: 105, component: Section })
