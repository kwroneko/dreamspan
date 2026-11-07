// Card sources: the built-in site recognizers (the card editor places `CardSources`), and the
// archives the server can browse (spec/CARD-SOURCES.md): their Settings page here.
import { routes } from "../../routes.tsx"
import { settingsGroups } from "../settings/groups.ts"
import { tabKinds } from "../workbench/kinds.ts"
import { RemoteCardPage } from "./RemoteCardPage.tsx"
import { SourcesSettingsPage } from "./SourcesSettings.tsx"
import { builtinRecognizers, sourceRecognizers } from "./sources.ts"

export { CardSources } from "./CardSources.tsx"

export const register = () => [
  ...builtinRecognizers.map((recognizer) => sourceRecognizers.register(recognizer)),
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
  tabKinds.register({
    id: "remote-card",
    order: 200,
    match: (url) => /^\/sources\/([^/]+\/cards\/[^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Card",
    icon: "person"
  })
]
