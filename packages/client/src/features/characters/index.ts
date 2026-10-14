import { routes } from "../../routes.tsx"
import { CardPage } from "./CardPage.tsx"
import { CharactersPage } from "./CharactersPage.tsx"
import { GroupPage } from "./GroupPage.tsx"

export const register = () => {
  // The home screen: the character grid (DESIGN §2.1).
  routes.register({ id: "characters", parent: "app", path: "/", component: CharactersPage })
  // A card without entering a chat; its pending chat is `/cards/$entityId/chat` (chat feature).
  routes.register({ id: "characters.card", parent: "app", path: "/cards/$entityId", component: CardPage })
  // A group's chats, named by any one of them (DESIGN §2.1).
  routes.register({ id: "characters.group", parent: "app", path: "/groups/$chatId", component: GroupPage })
}
