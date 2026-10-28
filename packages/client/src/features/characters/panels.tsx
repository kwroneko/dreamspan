import { chatPanels, lazyPanel } from "../chat/panels.tsx"

/** The character feature contributes the card tab family. */
export const registerCharacterPanels = () =>
  chatPanels.register({
    id: "character",
    label: "Character",
    order: 100,
    icon: "people",
    header: false,
    matches: (value) => /^card:[0-9a-f-]{36}$/.test(value),
    tabs: (view, selected) => {
      const cast = view.cast
      const tabs = (cast?.cards ?? [])
        .filter((card) => cast!.participants.includes(card.entityId) || cast!.playedByMe.includes(card.entityId))
        .map((card) => ({ value: `card:${card.entityId}`, label: card.label }))
      if (selected?.startsWith("card:") && !tabs.some((tab) => tab.value === selected))
        tabs.push({ value: selected, label: "Character" })
      return tabs
    },
    component: lazyPanel(
      () => import("../chat/CharacterTab.tsx").then((module) => ({ default: module.CharacterTab })),
      "character"
    )
  })
