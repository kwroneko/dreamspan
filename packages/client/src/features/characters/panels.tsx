import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import { lazy, Suspense } from "react"
import { chatPanels, lazyPanel, type PanelTabEntry, type PendingPanelProps } from "../chat/panels.tsx"
import { Loading } from "../../ui/Spinner.tsx"

/** The character feature contributes the card tab family: the cast strip, a portrait each. */
export const registerCharacterPanels = () =>
  chatPanels.register({
    id: "character",
    label: "Character",
    description: "A character's card, its fields edited right here.",
    order: 100,
    icon: "people",
    header: false,
    placement: "cast",
    holdsEditor: (ref, tab) => ref.kind === "card" && tab === `card:${ref.entityId}`,
    matches: (value) => /^card:[0-9a-f-]{36}$/.test(value),
    tabs: (view, selected) => {
      const cast = view.cast
      const tab = (card: CastCard): PanelTabEntry => ({
        value: `card:${card.entityId}`,
        label: card.label,
        avatar: { id: card.entityId, name: card.name, mediaId: card.avatarMediaId, crop: card.avatarCrop },
        ...(cast!.playedByMe.includes(card.entityId) ? { note: "you" } : {})
      })
      // In the chat's own order (its header's, the composer's), the persona (you) last.
      const place = (id: EntityId) =>
        (cast!.playedByMe.includes(id) ? cast!.participants.length + 1 : 0) + cast!.participants.indexOf(id)
      const tabs = (cast?.cards ?? [])
        .filter((card) => cast!.participants.includes(card.entityId) || cast!.playedByMe.includes(card.entityId))
        .sort((a, b) => place(a.entityId) - place(b.entityId))
        .map(tab)
      if (selected?.startsWith("card:") && !tabs.some((entry) => entry.value === selected)) {
        // One that left this chat on this branch keeps its tab; a card from another chat has
        // none here (the panel opens this chat's own character instead). Unknown until the cast loads.
        const departed = cast?.cards.find((card) => `card:${card.entityId}` === selected)
        if (departed) tabs.push(tab(departed))
        else if (!cast)
          tabs.push({
            value: selected,
            label: "Character",
            avatar: { id: selected.slice(5), name: "Character", mediaId: null }
          })
      }
      return tabs
    },
    component: lazyPanel(
      () => import("../chat/CharacterTab.tsx").then((module) => ({ default: module.CharacterTab })),
      "character"
    ),
    pending: PendingCharacter
  })

const LazyPendingCharacter = lazy(() =>
  import("../chat/CharacterTab.tsx").then((module) => ({ default: module.PendingCharacterTab }))
)
/** The same tab in a chat not made yet. */
function PendingCharacter(props: PendingPanelProps) {
  return (
    <Suspense fallback={<Loading label="Loading the character…" />}>
      <LazyPendingCharacter {...props} />
    </Suspense>
  )
}
