// The workshop's card on the Chats page (spec/WORKSHOP.md §2.2): the only place one is made, so
// nobody slips into one from a story.
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { StartChatForm } from "../chat/ChatsPage.tsx"

export function WorkshopStartCard() {
  return (
    <Card>
      <CardHeader
        title="Workshop"
        about="Ask an assistant about your cards, presets and lorebooks, outside any story."
      />
      <StartChatForm
        draft="workshop:new"
        label="Title of the new workshop"
        button="New workshop"
        hint="Opens a workshop. The assistant can read your library."
        create={(client, title) => client("CreateWorkshop", title.trim() === "" ? {} : { title })}
      />
    </Card>
  )
}
