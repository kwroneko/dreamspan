import { chatPanels, lazyPanel, type PanelTabEntry } from "../chat/panels.tsx"

/** The character feature contributes the card tab family: the cast strip, a portrait each. */
export const registerCharacterPanels = () =>
  chatPanels.register({
    id: "character",
    label: "Character",
    order: 100,
    icon: "people",
    header: false,
    placement: "cast",
    matches: (value) => /^card:[0-9a-f-]{36}$/.test(value),
    tabs: (view, selected) => {
      const cast = view.cast
      const tabs: Array<PanelTabEntry> = (cast?.cards ?? [])
        .filter((card) => cast!.participants.includes(card.entityId) || cast!.playedByMe.includes(card.entityId))
        .map((card) => ({
          value: `card:${card.entityId}`,
          label: card.label,
          avatar: { id: card.entityId, name: card.name, mediaId: card.avatarMediaId },
          ...(cast!.playedByMe.includes(card.entityId) ? { note: "you" } : {})
        }))
        // The characters spoken to first, the persona (you) last.
        .sort((a, b) => Number(a.note !== undefined) - Number(b.note !== undefined))
      if (selected?.startsWith("card:") && !tabs.some((tab) => tab.value === selected))
        tabs.push({
          value: selected,
          label: "Character",
          avatar: { id: selected.slice(5), name: "Character", mediaId: null }
        })
      return tabs
    },
    component: lazyPanel(
      () => import("../chat/CharacterTab.tsx").then((module) => ({ default: module.CharacterTab })),
      "character"
    )
  })
