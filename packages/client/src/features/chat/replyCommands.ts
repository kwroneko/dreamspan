import { chatCommands, emptyComposerTarget, keyTarget, typingTarget, type ChatCommandContext } from "./commands.tsx"
import { invokeMessageAction, messageActions, type MessageActionContext } from "./messageActions.tsx"
import { invokeVersionStep, versionNavigationAvailable } from "./versionNavigation.ts"
import { showToast } from "../../ui/Toast.tsx"
import { messageSide } from "./cast.ts"
import type { PathEntry } from "@dreamspan/shared/chat.ts"

const contextFor = ({ session, view }: ChatCommandContext, entry: PathEntry): MessageActionContext => {
  const report: MessageActionContext["report"] = (outcome) => {
    if (!outcome.ok) showToast({ title: outcome.error.message })
  }
  return {
    entry,
    session,
    branchFork: view.forkId,
    generated: messageSide(entry, view.cast) === "assistant" || entry.version.writer === "model",
    generating: entry.version.status === "generating",
    hidden: entry.hiddenByUser,
    report,
    toast: report
  }
}
const latestContext = (context: ChatCommandContext, own = false): MessageActionContext | null => {
  const { view } = context
  const entry =
    view.newer === null
      ? own
        ? view.entries.findLast((entry) => messageSide(entry, view.cast) === "user")
        : view.entries.at(-1)
      : undefined
  return entry && !view.loading ? contextFor(context, entry) : null
}
const availableAction = (context: ChatCommandContext, id: string, own = false) => {
  const target = latestContext(context, own)
  const action = messageActions.get(id)
  return target !== null && action?.run !== undefined && action.available?.(target) !== false
}
const canSearchOwn = ({ view }: ChatCommandContext) => !view.loading && view.newer === null && view.older != null
const editLast = async (context: ChatCommandContext, own: boolean) => {
  const target = latestContext(context, own)
  if (target) return invokeMessageAction("message.edit", target, "keyboard")
  if (!own || !canSearchOwn(context)) return
  const { session, view } = context
  let from = view.older
  while (from !== null) {
    const cursor = from
    const result = await session.call((client) =>
      client("ReadPath", {
        chatId: session.id,
        forkId: view.forkId,
        leafSlotId: view.leafSlotId,
        range: { _tag: "Older", from: cursor },
        limit: 60
      })
    )
    const current = session.snapshot()
    if (
      current.loading ||
      current.newer !== null ||
      current.forkId !== view.forkId ||
      current.leafSlotId !== view.leafSlotId ||
      current.pathRevision !== view.pathRevision ||
      current.cast !== view.cast
    )
      return
    if (!result.ok) {
      showToast({ title: result.error.message })
      return
    }
    const entry = result.value.entries.findLast((entry) => messageSide(entry, view.cast) === "user")
    if (entry) {
      const found = contextFor(context, entry)
      const action = messageActions.get("message.edit")
      if (action?.run && action.available?.(found) !== false) {
        context.onJump(entry.slotId)
        return invokeMessageAction("message.edit", found, "keyboard")
      }
      return
    }
    from = result.value.older
  }
}
const stepLast = (context: ChatCommandContext, direction: -1 | 1) => {
  const target = latestContext(context)
  if (target) void invokeVersionStep(target, direction)
}
export const registerReplyCommands = () => [
  chatCommands.register({
    id: "reply.continue",
    label: "Continue latest reply",
    description: "Writes more of the latest reply, from the page or the composer.",
    order: 30,
    icon: "continue",
    shortcut: { key: "Enter", mod: false, alt: true },
    acceptsKey: (event) => !typingTarget(event) || keyTarget(event)?.matches('[data-testid="composer"]') === true,
    available: (context) => availableAction(context, "message.continue"),
    run: (context) => {
      const target = latestContext(context)
      if (target) void invokeMessageAction("message.continue", target, "keyboard")
    }
  }),
  chatCommands.register({
    id: "reply.edit-last",
    label: "Edit last message",
    description: "From an empty composer: edits the chat's last message.",
    order: 31,
    icon: "edit",
    shortcut: { key: "ArrowUp", mod: false },
    acceptsKey: emptyComposerTarget,
    available: (context) => availableAction(context, "message.edit"),
    run: (context) => void editLast(context, false)
  }),
  chatCommands.register({
    id: "reply.edit-own",
    label: "Edit your last message",
    description: "Edits the last message you wrote, from an empty composer or anywhere but a text field.",
    order: 32,
    icon: "edit",
    shortcut: { key: "ArrowUp", mod: true },
    acceptsKey: (event) => !typingTarget(event) || emptyComposerTarget(event),
    available: (context) =>
      availableAction(context, "message.edit", true) ||
      (latestContext(context, true) === null &&
        canSearchOwn(context) &&
        messageActions.get("message.edit")?.run !== undefined),
    run: (context) => void editLast(context, true)
  }),
  ...([-1, 1] as const).map((direction) =>
    chatCommands.register({
      id: direction === -1 ? "reply.previous-version" : "reply.next-version",
      label: direction === -1 ? "Previous swipe of last reply" : "Next swipe of last reply",
      description:
        direction === -1
          ? "Shows the latest reply's swipe before the one shown."
          : "Shows the latest reply's next swipe; past its last, writes a new one.",
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
    label: "Save message edit",
    description: "Saves the message being edited.",
    order: 35,
    icon: "edit",
    shortcut: { key: "Enter", mod: true },
    acceptsKey: () => true,
    available: (context) => context.saveMessageEdit !== undefined,
    run: (context) => context.saveMessageEdit?.()
  })
]
