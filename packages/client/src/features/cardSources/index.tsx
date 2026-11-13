// Card sources: the built-in site recognizers (the card editor places `CardSources`), and the
// archives the server can browse (spec/CARD-SOURCES.md): their Settings page here, and the
// notice of a newer version of a card added from one (§3.8) under every card editor's actions.
import { routes } from "../../routes.tsx"
import { editorNotices } from "../editor/editorSlots.ts"
import { settingsGroups } from "../settings/groups.ts"
import { tabKinds } from "../workbench/kinds.ts"
import { RemoteCardPage } from "./RemoteCardPage.tsx"
import { RemoteLorebookPage } from "./RemoteLorebookPage.tsx"
import { SourcesSettingsPage } from "./SourcesSettings.tsx"
import { builtinRecognizers, sourceRecognizers } from "./sources.ts"
import { SourceUpdateNotice } from "./updates.tsx"

export { CardSources } from "./CardSources.tsx"

export const register = () => [
  ...builtinRecognizers.map((recognizer) => sourceRecognizers.register(recognizer)),
  editorNotices.register({ id: "card-sources.update", order: 5, component: SourceUpdateNotice }),
  settingsGroups.register({ id: "cards", label: "Cards", order: 25, pages: ["settings.cardSources"] }),
  routes.register({
    id: "settings.cardSources",
    parent: "settings",
    path: "card-sources",
    component: SourcesSettingsPage,
    nav: { label: "Card sources", order: 10, description: "Card archives you can browse from the home page." }
  }),
  // A card on a source, shown without adding it.
  routes.register({
    id: "cardSources.card",
    parent: "app",
    path: "/sources/$sourceId/cards/$remoteId",
    component: RemoteCardPage
  }),
  // A standalone lorebook on a source: opening it adds it, then shows it in the lorebook editor (§3.9).
  routes.register({
    id: "cardSources.lorebook",
    parent: "app",
    path: "/sources/$sourceId/lorebooks/$remoteId",
    component: RemoteLorebookPage
  }),
  tabKinds.register({
    id: "remote-lorebook",
    order: 201,
    match: (url) => /^\/sources\/([^/]+\/lorebooks\/[^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Lorebook",
    icon: "book"
  }),
  tabKinds.register({
    id: "remote-card",
    order: 200,
    match: (url) => /^\/sources\/([^/]+\/cards\/[^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Card",
    icon: "person"
  })
]
