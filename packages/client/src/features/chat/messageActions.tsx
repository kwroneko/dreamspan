// One registration owns an action's toolbar and menu offers, including its dialogs.
import type { BinItem } from "@rp/shared/bin.ts"
import type { ForkId, PathEntry } from "@rp/shared/chat.ts"
import { useState, useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import { Icon } from "../../ui/Icon.tsx"
import { Menu } from "../../ui/Menu.tsx"
import { iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import type { ChatSession, Outcome } from "./session.ts"

export interface MessageActionContext {
  readonly entry: PathEntry
  readonly session: ChatSession
  readonly branchFork: ForkId | null
  readonly generated: boolean
  readonly generating: boolean
  readonly hidden: boolean
  readonly report: (outcome: Outcome<unknown>) => void
  readonly toast: (outcome: Outcome<BinItem>) => void
}

export interface MessageActionProps extends MessageActionContext {
  readonly openDialog: (id: string) => void
  readonly closeDialog: () => void
}

export interface MessageAction {
  readonly id: string
  readonly order: number
  readonly available?: (context: MessageActionContext) => boolean
  readonly run?: (context: MessageActionContext, source: "button" | "keyboard") => void | Promise<void>
  readonly toolbar?: ComponentType<MessageActionProps>
  readonly menu?: ComponentType<MessageActionProps>
  readonly dialog?: ComponentType<MessageActionProps>
}

export const messageActions = makeRegistry<MessageAction>()
export const availableMessageActions = (context: MessageActionContext, snapshot = messageActions.snapshot()) =>
  [...snapshot.entries].sort((a, b) => a.order - b.order).filter((entry) => entry.available?.(context) !== false)

/** Resolve the effective action, including plugin disablement and availability. */
export const invokeMessageAction = (id: string, context: MessageActionContext, source: "button" | "keyboard") => {
  const action = messageActions.get(id)
  if (action?.available?.(context) === false) return
  return action?.run?.(context, source)
}

export function MessageActions({ context }: { context: MessageActionContext }) {
  // Availability can depend on the path tip even when this row's entry stayed identical.
  const readTip = () => {
    const view = context.session.snapshot()
    return `${view.forkId}:${view.loading}:${view.newer}:${view.entries.at(-1)?.slotId}`
  }
  useSyncExternalStore(context.session.subscribe, readTip, readTip)
  const snapshot = useSyncExternalStore(messageActions.subscribe, messageActions.snapshot, messageActions.snapshot)
  const actions = availableMessageActions(context, snapshot)
  const [dialog, setDialog] = useState<MessageAction | null>(null)
  const activeDialog = dialog !== null && actions.includes(dialog) ? dialog : null
  if (dialog !== null && activeDialog === null) setDialog(null)
  const props = {
    ...context,
    openDialog: (id: string) => setDialog(messageActions.get(id) ?? null),
    closeDialog: () => setDialog(null)
  }
  return (
    <>
      {actions.map((action) => (action.toolbar ? <action.toolbar key={action.id} {...props} /> : null))}
      {actions.some((action) => action.menu) && (
        <Menu
          align="end"
          label="More actions"
          trigger={
            <Tooltip label="More actions">
              <button type="button" aria-label="More actions" className={iconButtonClass()}>
                <Icon name="more" />
              </button>
            </Tooltip>
          }
        >
          {actions.map((action) => (action.menu ? <action.menu key={action.id} {...props} /> : null))}
        </Menu>
      )}
      {activeDialog?.dialog && <activeDialog.dialog {...props} />}
    </>
  )
}
