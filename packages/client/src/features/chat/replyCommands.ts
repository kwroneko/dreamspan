import { chatCommands, type ChatCommandContext } from "./commands.tsx"
import { invokeMessageAction, messageActions, type MessageActionContext } from "./messageActions.tsx"
import { showToast } from "../../ui/Toast.tsx"

const latestContext = ({ session, view }: ChatCommandContext): MessageActionContext | null => {
  const entry = view.newer === null ? view.entries.at(-1) : undefined
  if (!entry || view.loading) return null
  const report: MessageActionContext["report"] = (outcome) => {
    if (!outcome.ok) showToast({ title: outcome.error.message })
  }
  return {
    entry,
    session,
    branchFork: view.forkId,
    generated: entry.version.writer === "model",
    generating: entry.version.status === "generating",
    hidden: entry.hiddenByUser,
    report,
    toast: report
  }
}
export const registerReplyCommands = () => [
  chatCommands.register({
    id: "reply.continue",
    label: "Continue latest reply (Alt+Enter)",
    order: 30,
    icon: "continue",
    shortcut: { key: "Enter", mod: false, alt: true },
    available: (context) => {
      const target = latestContext(context)
      const action = messageActions.get("message.continue")
      return target !== null && action?.run !== undefined && action.available?.(target) !== false
    },
    run: (context) => {
      const target = latestContext(context)
      if (target) void invokeMessageAction("message.continue", target, "keyboard")
    }
  })
]
