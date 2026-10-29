import { lazy, Suspense } from "react"
import { cardContributions } from "../cardForks/surfaces.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { cardSavedContributions } from "../editor/cardSaved.ts"
import { Loading } from "../../ui/Spinner.tsx"

const RenameHistory = lazy(() => import("./RenameHistory.tsx").then((m) => ({ default: m.RenameHistory })))
const Resume = lazy(() => import("./Resume.tsx").then((m) => ({ default: m.Resume })))
export const register = () => [
  cardContributions.register({
    id: "card-rename.resume",
    placement: "actions",
    order: 200,
    component: (props) => (
      <Suspense fallback={null}>
        <Resume entityId={props.entityId} />
      </Suspense>
    )
  }),
  chatCardActions.register({
    id: "card-rename.resume",
    order: 200,
    component: ({ card }) => (
      <Suspense fallback={null}>
        <Resume entityId={card.entityId} />
      </Suspense>
    )
  }),
  cardSavedContributions.register({
    id: "card-rename.history",
    order: 100,
    applies: ({ oldName, newName }) => oldName.length > 0 && oldName !== newName,
    component: (props) => (
      <Suspense fallback={<Loading label="Loading history replacement…" />}>
        <RenameHistory {...props} />
      </Suspense>
    )
  })
]
