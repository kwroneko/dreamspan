// The workshop's card on the Chats page (spec/WORKSHOP.md §2.2): the only place one is made, so
// nobody slips into one from a story.
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { StartChatForm } from "../chat/ChatsPage.tsx"

export function WorkshopStartCard() {
  return (
    <Card>
      <CardHeader
        title="Workshop"
        about="Work with an assistant on your cards, chats and settings, outside any story."
      />
      <StartChatForm
        draft="workshop:new"
        label="Title of the new workshop"
        button="New workshop"
        hint="Opens a workshop chat. It can change your library and settings; you choose what it may do."
        create={(client, title) => client("CreateWorkshop", title.trim() === "" ? {} : { title })}
      />
    </Card>
  )
}
