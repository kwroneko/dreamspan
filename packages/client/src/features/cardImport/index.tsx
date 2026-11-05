// "Import a new version…" of a card, registered the way a plugin would: in the card's
// actions (the editor's More menu, the card page), a chat's character tab, and a library
// card's item menu, where it takes the place of "Update from file…" (which merges, and stays
// for presets and lorebooks). Each registration can be replaced or disabled on its own.
import { lazy, Suspense } from "react"
import { cardContributions } from "../cardForks/surfaces.tsx"
import { chatCardActions } from "../chat/presentation.tsx"
import { libraryItemActions } from "../library/itemActions.tsx"

const Action = lazy(() => import("./ImportNewVersion.tsx").then((m) => ({ default: m.ImportNewVersion })))
const MenuEntry = lazy(() => import("./ImportNewVersion.tsx").then((m) => ({ default: m.NewVersionMenuItem })))
const Dialog = lazy(() => import("./ImportNewVersion.tsx").then((m) => ({ default: m.NewVersionDialog })))

/** What the action does, beside its library menu entry. */
const DESCRIPTION =
  "Replaces the card with a new version of its file, or merges the file's changes into it, after showing what changes."

export const register = () => [
  cardContributions.register({
    id: "card-import.new-version",
    placement: "actions",
    overflow: false,
    order: 160,
    component: ({ entityId, label, store }) => (
      <Suspense fallback={null}>
        <Action
          entityId={entityId}
          label={label ?? store?.snapshot?.ref.label ?? "this card"}
          {...(store ? { refId: store.refId } : {})}
        />
      </Suspense>
    )
  }),
  chatCardActions.register({
    id: "card-import.new-version",
    order: 40,
    component: ({ card, info }) => (
      <Suspense fallback={null}>
        <Action entityId={card.entityId} label={card.name} compact {...(info ? { refId: info.refId } : {})} />
      </Suspense>
    )
  }),
  libraryItemActions.register({
    id: "card-import.new-version",
    order: 40,
    available: ({ entry }) => entry.kind === "card" && entry.refKind === "upstream",
    menu: (props) => (
      <Suspense fallback={null}>
        <MenuEntry openDialog={props.openDialog} description={props.description} />
      </Suspense>
    ),
    dialog: (props) => (
      <Suspense fallback={null}>
        <Dialog refId={props.entry.id} label={props.entry.label} onClose={props.closeDialog} />
      </Suspense>
    ),
    description: DESCRIPTION
  })
]
