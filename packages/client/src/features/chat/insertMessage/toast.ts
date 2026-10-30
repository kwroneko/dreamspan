import type { SlotId } from "@rp/shared/chat.ts"
import { showToast } from "../../../ui/Toast.tsx"
import type { ChatSession } from "../session.ts"

/** "Message inserted" with Undo: the message to the bin, its generation stopped first. */
export const insertedToast = (session: ChatSession, slotId: SlotId, title: string) =>
  showToast({
    title,
    actions: [
      {
        label: "Undo",
        onClick: () =>
          void session.undoInsert(slotId).then((outcome) => {
            if (!outcome.ok) showToast({ title: "Couldn't undo it", description: outcome.error.message })
          })
      }
    ]
  })
