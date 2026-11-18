import { cardGrouping } from "./cardGrouping.tsx"
import { groupFamilies } from "./cardFamilies.ts"
import { GroupFamiliesToggle } from "./cardBrowse.tsx"
import { ArchivedMatches } from "./ArchivedMatches.tsx"
import { ArchiveUnused } from "./ArchiveUnused.tsx"
import { archivedCardActions, cardSearchExtras } from "./homeSlots.ts"
import { CardArchive, CardArchiveMenu } from "./CardArchive.tsx"
import { sidebarSearch } from "./sidebarSearch.ts"
import { shellSearchKeys, tabKinds } from "../workbench/kinds.ts"
import { SplitChatSection } from "../chat/SplitChatSection.tsx"
import { panelEditorActions } from "../editor/panelActions.tsx"
import { PanelFavourite } from "./CardFavourite.tsx"
import { ChatBrowseBar, sidebarChatBrowse } from "./ChatBrowseBar.tsx"
import { MessageResults, MessageSearchToggle, sidebarMessageResults, sidebarSearchTools } from "./MessageSearch.tsx"
import { registerCharacterPanels } from "./panels.tsx"
import { routes } from "../../routes.tsx"
import { CardPage } from "./CardPage.tsx"
import { CharactersPage } from "./CharactersPage.tsx"
import { GroupPage } from "./GroupPage.tsx"
import { characterChatActions, sidebarFoot } from "./homeSlots.ts"
import { NewCharacterChat } from "./NewCharacterChat.tsx"
import { OpenChatBranches } from "./ShellBrowser.tsx"
import { homeSearch } from "./homeSearch.ts"
import { cardContributions } from "../cardForks/surfaces.tsx"
import { registerDefaultPersona } from "./defaultPersona.tsx"
import { PersonaFolderSwitch } from "./personaFolder.tsx"
import { CardChatsLink, CastChatsLink } from "./chatLinks.tsx"
import { castMemberNavigation } from "../chat/presentation.tsx"
import { layoutParams } from "../../tabLayoutParams.ts"
import { FOOT_PARAMS } from "./useBranchHeight.tsx"

export const register = () => {
  cardGrouping.register({ id: "forks", group: groupFamilies, control: GroupFamiliesToggle })
  cardContributions.register({
    id: "cards.archive-toggle",
    placement: "archive-toggle",
    order: 10,
    component: CardArchive
  })
  cardContributions.register({
    id: "cards.archive-tile-menu",
    placement: "tile-menu",
    order: 10,
    component: CardArchiveMenu
  })
  archivedCardActions.register({ id: "cards.archive-unused", order: 10, component: ArchiveUnused })
  cardSearchExtras.register({ id: "cards.archived-search", order: 10, component: ArchivedMatches })
  registerDefaultPersona()
  panelEditorActions.register({ id: "characters.panel-favourite", order: 40, component: PanelFavourite })
  characterChatActions.register({ id: "characters.new-chat", order: 10, component: NewCharacterChat })
  cardContributions.register({
    id: "characters.chats-link",
    placement: "chats",
    order: 10,
    component: CardChatsLink
  })
  castMemberNavigation.register({ id: "characters.chats-link", order: 10, component: CastChatsLink })
  sidebarChatBrowse.register({ id: "chats.browse", order: 10, component: ChatBrowseBar })
  sidebarSearchTools.register({ id: "chats.message-search", order: 10, component: MessageSearchToggle })
  sidebarMessageResults.register({ id: "chats.message-results", order: 10, component: MessageResults })
  // The Persona switch in a card's header and on its page (personaFolder.tsx).
  cardContributions.register({
    id: "characters.persona-folder",
    placement: "header",
    order: 10,
    component: PersonaFolderSwitch
  })
  registerCharacterPanels()
  // The open chat's branches at the left panel's foot, below whatever it lists.
  sidebarFoot.register({ id: "open-chat-branches", order: 10, component: OpenChatBranches })
  sidebarFoot.register({ id: "split-chats", order: 20, component: SplitChatSection })
  // The sidebar's place belongs to the browser's URL, never to a tab (features/workbench).
  shellSearchKeys.register({ id: "characters.sidebar", keys: sidebarSearch })
  // The sidebar foot's closed sections and heights: the browser tab's layout (tabLayoutParams.ts).
  layoutParams.register({
    id: "characters.sidebar-foot",
    keys: [...Object.values(FOOT_PARAMS.open), ...Object.values(FOOT_PARAMS.height)]
  })
  tabKinds.register({
    id: "card",
    order: 200,
    match: (url) => /^\/cards\/([^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Card",
    icon: "person"
  })
  tabKinds.register({
    id: "group",
    order: 200,
    match: (url) => /^\/groups\/([^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Group",
    icon: "people"
  })
  // The home screen: the character grid (DESIGN §2.1).
  routes.register({ id: "characters", parent: "app", path: "/", component: CharactersPage, retainSearch: homeSearch })
  // A card without entering a chat; its pending chat is `/cards/$entityId/chat` (chat feature).
  routes.register({ id: "characters.card", parent: "app", path: "/cards/$entityId", component: CardPage })
  // A group's chats, named by any one of them (DESIGN §2.1).
  routes.register({ id: "characters.group", parent: "app", path: "/groups/$chatId", component: GroupPage })
}
