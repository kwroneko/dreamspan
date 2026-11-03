import { registerCharacterPanels } from "./panels.tsx"
import { routes } from "../../routes.tsx"
import { CardPage } from "./CardPage.tsx"
import { CharactersPage } from "./CharactersPage.tsx"
import { GroupPage } from "./GroupPage.tsx"
import { sidebarActions } from "../shell.tsx"
import { StartChatPicker } from "./StartChatPicker.tsx"
import { sidebarFoot } from "./homeSlots.ts"
import { OpenChatBranches } from "./ShellBrowser.tsx"
import { homeSearch } from "./homeSearch.ts"
import { cardContributions } from "../cardForks/surfaces.tsx"
import { PersonaFolderSwitch } from "./personaFolder.tsx"
import { CardChatsLink, CastChatsLink } from "./chatLinks.tsx"
import { castMemberNavigation } from "../chat/presentation.tsx"

export const register = () => {
  cardContributions.register({
    id: "characters.chats-link",
    placement: "chats",
    order: 10,
    component: CardChatsLink
  })
  castMemberNavigation.register({ id: "characters.chats-link", order: 10, component: CastChatsLink })
  // The Persona switch in a card's header and on its page (personaFolder.tsx).
  cardContributions.register({
    id: "characters.persona-folder",
    placement: "header",
    order: 10,
    component: PersonaFolderSwitch
  })
  registerCharacterPanels()
  // The sidebar's "Start a chat with…" search, beside the app's name.
  sidebarActions.register({ id: "start-chat", order: 10, component: StartChatPicker })
  // The open chat's branches at the left panel's foot, below whatever it lists.
  sidebarFoot.register({ id: "open-chat-branches", order: 10, component: OpenChatBranches })
  // The home screen: the character grid (DESIGN §2.1).
  routes.register({ id: "characters", parent: "app", path: "/", component: CharactersPage, retainSearch: homeSearch })
  // A card without entering a chat; its pending chat is `/cards/$entityId/chat` (chat feature).
  routes.register({ id: "characters.card", parent: "app", path: "/cards/$entityId", component: CardPage })
  // A group's chats, named by any one of them (DESIGN §2.1).
  routes.register({ id: "characters.group", parent: "app", path: "/groups/$chatId", component: GroupPage })
}
