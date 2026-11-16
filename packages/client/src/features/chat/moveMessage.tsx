// Moving a message up or down in its branch (owner, 2026-11-16): two message actions in More
// actions, each with an Undo toast. Later replies in this branch see the new order; other
// branches keep theirs. Registrations, so a plugin can replace or disable them.
import { showToast } from "../../ui/Toast.tsx"
import { messageActions, viewOf, type MessageActionContext } from "./messageActions.tsx"

/** The shown message before or after this one in the loaded view, if any. */
const neighbour = ({ session, entry }: MessageActionContext, direction: "up" | "down") => {
  const view = session.snapshot()
  const shown = view.entries
  const index = shown.findIndex((e) => e.slotId === entry.slotId)
  if (index < 0) return null
  const other = shown[direction === "up" ? index - 1 : index + 1]
  if (other !== undefined) return other
  // Past the loaded page there may be more: only the real ends refuse.
  return (direction === "up" ? view.older : view.newer) !== null ? true : null
}

const move = (direction: "up" | "down") =>
  viewOf((context) => {
    const { session, entry, report, generating } = context
    const end = neighbour(context, direction) === null
    const refusal = generating
      ? "Wait until it's finished."
      : end
        ? direction === "up"
          ? "It's already the first message."
          : "It's already the last message."
        : null
    return {
      label: direction === "up" ? "Move up" : "Move down",
      icon: direction === "up" ? "move-up" : "move-down",
      hint:
        direction === "up"
          ? "Swap this message with the one above it, in this branch only. Later replies see the new order."
          : "Swap this message with the one below it, in this branch only. Later replies see the new order.",
      ...(refusal !== null ? { disabled: refusal } : {}),
      onSelect: async () => {
        const outcome = await session.moveMessage(entry, direction)
        report(outcome)
        if (outcome.ok)
          showToast({
            title: direction === "up" ? "Message moved up" : "Message moved down",
            description: "Summaries over the old order are marked stale.",
            actions: [
              {
                label: "Undo",
                onClick: () =>
                  void session.undoMove(outcome.value).then((undone) => {
                    if (!undone.ok) showToast({ title: "Couldn't undo it", description: undone.error.message })
                  })
              }
            ]
          })
      }
    }
  })

export const register = () => [
  messageActions.register({ id: "message.move-up", order: 73, group: "place", describe: move("up") }),
  messageActions.register({ id: "message.move-down", order: 74, group: "place", describe: move("down") })
]
