// The workshop's card on the Chats page (spec/WORKSHOP.md §2.2): where a workshop of its own is
// made. One beside a story is made from that story (SidePanel.tsx), never by slipping into one.
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
        hint="Opens a workshop. The assistant can read and change your library and set up chats."
        create={(client, title) => client("CreateWorkshop", title.trim() === "" ? {} : { title })}
      />
    </Card>
  )
}
