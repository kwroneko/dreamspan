// Export… beside a card's other actions: the full editor's header (`cardContributions`
// `actions`) and the chat's character tab (`chatCardActions`). The library's item menu has its
// own Export as group (`library.export`). Each is a registration of its own, so a plugin can
// replace or disable either.
import { cardContributions } from "../cardForks/surfaces.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { CardExport } from "./CardExport.tsx"

export const register = () => [
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
