import { chatCommands, emptyComposerTarget, keyTarget, typingTarget, type ChatCommandContext } from "./commands.tsx"
import { invokeMessageAction, messageActions, type MessageActionContext } from "./messageActions.tsx"
import { invokeVersionStep, versionNavigationAvailable } from "./versionNavigation.ts"
import { showToast } from "../../ui/Toast.tsx"

const latestContext = ({ session, view }: ChatCommandContext, own = false): MessageActionContext | null => {
  const entry =
    view.newer === null
      ? own
        ? view.entries.findLast((entry) => entry.side === "user")
        : view.entries.at(-1)
      : undefined
  if (!entry || view.loading) return null
  const report: MessageActionContext["report"] = (outcome) => {
    if (!outcome.ok) showToast({ title: outcome.error.message })
  }
  return {
    entry,
    session,
    branchFork: view.forkId,
    generated: entry.side === "assistant" || entry.version.writer === "model",
    generating: entry.version.status === "generating",
    hidden: entry.hiddenByUser,
    report,
    toast: report
  }
}
const availableAction = (context: ChatCommandContext, id: string, own = false) => {
  const target = latestContext(context, own)
  const action = messageActions.get(id)
  return target !== null && action?.run !== undefined && action.available?.(target) !== false
}
const editLast = (context: ChatCommandContext, own: boolean) => {
  const target = latestContext(context, own)
  if (target) void invokeMessageAction("message.edit", target, "keyboard")
}
const stepLast = (context: ChatCommandContext, direction: -1 | 1) => {
  const target = latestContext(context)
  if (target) void invokeVersionStep(target, direction)
}
export const registerReplyCommands = () => [
  chatCommands.register({
    id: "reply.continue",
    label: "Continue latest reply (Alt+Enter)",
    order: 30,
    icon: "continue",
    shortcut: { key: "Enter", mod: false, alt: true },
    acceptsKey: (event) =>
      !typingTarget(event) || keyTarget(event)?.matches('textarea[data-testid="composer"]') === true,
    available: (context) => availableAction(context, "message.continue"),
    run: (context) => {
      const target = latestContext(context)
      if (target) void invokeMessageAction("message.continue", target, "keyboard")
    }
  }),
  chatCommands.register({
    id: "reply.edit-last",
    label: "Edit last message (ArrowUp in empty composer)",
    order: 31,
    icon: "edit",
    shortcut: { key: "ArrowUp", mod: false },
    acceptsKey: emptyComposerTarget,
    available: (context) => availableAction(context, "message.edit"),
    run: (context) => editLast(context, false)
  }),
  chatCommands.register({
    id: "reply.edit-own",
    label: "Edit your last message (Ctrl+ArrowUp)",
    order: 32,
    icon: "edit",
    shortcut: { key: "ArrowUp", mod: true },
    acceptsKey: (event) => !typingTarget(event) || emptyComposerTarget(event),
    available: (context) => availableAction(context, "message.edit", true),
    run: (context) => editLast(context, true)
  }),
  ...([-1, 1] as const).map((direction) =>
    chatCommands.register({
      id: direction === -1 ? "reply.previous-version" : "reply.next-version",
      label:
        direction === -1
          ? "Previous version of last reply (ArrowLeft)"
          : "Next version of last reply (ArrowRight; generates past last)",
      order: direction === -1 ? 33 : 34,
      icon: direction === -1 ? ("left" as const) : ("right" as const),
      shortcut: { key: direction === -1 ? "ArrowLeft" : "ArrowRight", mod: false },
      available: (context) => {
        const target = latestContext(context)
        return target !== null && target.generated && !target.generating && versionNavigationAvailable()
      },
      run: (context) => stepLast(context, direction)
    })
  ),
  chatCommands.register({
    id: "message.save",
    label: "Save message edit (Ctrl+Enter)",
    order: 35,
    icon: "edit",
    shortcut: { key: "Enter", mod: true },
    acceptsKey: () => true,
    available: (context) => context.saveMessageEdit !== undefined,
    run: (context) => context.saveMessageEdit?.()
  })
]
