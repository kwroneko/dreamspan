// Export… beside a card's other actions: the full editor's header (`cardContributions`
// `actions`) and the chat's character and persona tabs (`chatCardActions`). The library's item
// menu shares ExportMenu (`library.export`); Cast uses its submenu. Every one asks through
// `requestExport`, answered by the check registered here in `appTools` (`card-export.check`):
// unsaved changes are asked about before the file is written (owner, 2026-11-02). Each is a
// registration of its own, so a plugin can replace or disable it.
import { lazy, Suspense } from "react"
import { cardContributions } from "../cardForks/surfaces.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { appTools } from "../shell.tsx"
import { CardExport } from "./CardExport.tsx"
import { useExportRequest } from "./exportRequests.ts"

const ExportCheck = lazy(() => import("./ExportCheck.tsx"))

function ExportCheckHost() {
  const request = useExportRequest()
  return (
    request && (
      <Suspense fallback={null}>
        <ExportCheck key={request.id} request={request} />
      </Suspense>
    )
  )
}

export const register = () => [
  appTools.register({ id: "card-export.check", order: 210, component: ExportCheckHost }),
  cardContributions.register({
    id: "card-export.editor",
    placement: "actions",
    order: 150,
    component: ({ store, label }) =>
      store ? <CardExport refId={store.refId} label={label ?? store.snapshot?.ref.label ?? "card"} /> : null
  }),
  chatCardActions.register({
    id: "card-export.chat",
    order: 150,
    component: ({ card, info }) => (info ? <CardExport refId={info.refId} label={card.name} compact /> : null)
  })
]
