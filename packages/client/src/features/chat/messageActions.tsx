// A message's actions, as registrations (spec/PLUGINS.md §8). Each one describes itself once
// (its name, icon, explanation and what choosing it does on this message) and owns its dialog.
// The host lists every available action in the message's "More actions" menu, in order, each
// with a checkbox that shows it as a button on the message too: the user's choices are kept
// by action id with the account's display preferences, over each action's own default, so a
// plugin's action can be pinned like a built-in one.
import type { BinItem } from "@rp/shared/bin.ts"
import type { ForkId, PathEntry } from "@rp/shared/chat.ts"
import {
  cloneElement,
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode
} from "react"
import { makeRegistry } from "../../registry.ts"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { Menu, MenuItemWithCheckbox, MenuSeparator } from "../../ui/Menu.tsx"
import { IconButton, iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
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

/** How an action shows on one message: its menu row and, when pinned, its button. */
export interface MessageActionView {
  /** Short: the row's text and the button's accessible name ("Delete message"). */
  readonly label: string
  /** What it does here, in full: the tooltip beside the row and the button ("…all 12 versions"). */
  readonly hint: string
  /** No two actions share one. */
  readonly icon: IconName
  readonly tone?: "default" | "danger"
  /** Why it can't be used on this message now: shown disabled, with this under its row's label. */
  readonly disabled?: string
  /** Shown faded but still chosen, when choosing it says why it can't run (Continue without a model). */
  readonly dimmed?: boolean
  /** What choosing it does. */
  readonly onSelect?: () => unknown
  /** Or where it goes: a link element (a router `Link`, without children) the row and button render as. */
  readonly link?: ReactElement
}

export interface MessageActionDescribeProps extends MessageActionProps {
  /** Renders the action as the host places it: a menu row, or a button on the message. */
  readonly show: (view: MessageActionView) => ReactNode
}

export interface MessageAction {
  readonly id: string
  /** Its place in the menu, and on the message among the pinned. */
  readonly order: number
  /** Actions of one group sit together in the menu; a separator falls between groups. */
  readonly group?: string
  /** Whether this action applies to this kind of message. */
  readonly available?: (context: MessageActionContext) => boolean
  /** Temporary unavailability keeps the button in place and explains why. */
  readonly disabled?: (context: MessageActionContext) => string | null
  /** Shown on the message as a button until the user unticks it. */
  readonly pinned?: boolean
  /** The keyboard's (and a double-click's) way in, where it has one. */
  readonly run?: (context: MessageActionContext, source: "button" | "keyboard") => void | Promise<void>
  /**
   * Calls `show` with its view on this message. A component, so the view may follow state
   * (a hook); `viewOf` makes one from a plain function.
   */
  readonly describe: ComponentType<MessageActionDescribeProps>
  readonly dialog?: ComponentType<MessageActionProps>
}

/** A `describe` from a function of the message: for the actions whose view needs no state. */
export const viewOf = (view: (props: MessageActionProps) => MessageActionView) =>
  function Describe({ show, ...props }: MessageActionDescribeProps) {
    return show(view(props))
  }

export const messageActions = makeRegistry<MessageAction>()
export const availableMessageActions = (context: MessageActionContext, snapshot = messageActions.snapshot()) =>
  [...snapshot.entries].sort((a, b) => a.order - b.order).filter((entry) => entry.available?.(context) !== false)

/** Resolve the effective action, including plugin disablement and availability. */
export const invokeMessageAction = (id: string, context: MessageActionContext, source: "button" | "keyboard") => {
  const action = messageActions.get(id)
  if (action?.available?.(context) === false || action?.disabled?.(context)) return
  return action?.run?.(context, source)
}

/** The user's pin choices by action id, over each action's default. */
export type PinChoices = Readonly<Record<string, boolean>>

const isPinned = (action: MessageAction, choices: PinChoices) => choices[action.id] ?? action.pinned === true

interface PinState {
  readonly choices: PinChoices
  /** The last choice that couldn't be saved, said in the menu. */
  readonly error: string | null
}

/**
 * Which actions are pinned, for every message host. The account's display preferences feed it
 * (`MessageToolbarPreferences`, mounted app-wide) and save its choices; without them (a test,
 * a page without an account) choices stay in the tab.
 */
class PinStore {
  private state: PinState = { choices: {}, error: null }
  private save: ((id: string, pinned: boolean) => void) | null = null
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  readonly snapshot = () => this.state

  private set(state: PinState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  /** The account's choices as they now stand, and how to save one; null when it signs out. */
  connect(choices: PinChoices, error: string | null, save: ((id: string, pinned: boolean) => void) | null) {
    this.save = save
    if (choices !== this.state.choices || error !== this.state.error) this.set({ choices, error })
  }

  choose(id: string, pinned: boolean) {
    if (this.save !== null) this.save(id, pinned)
    else this.set({ choices: { ...this.state.choices, [id]: pinned }, error: null })
  }
}

export const messageActionPins = new PinStore()

/** A pinned action as a button on the message. */
function PinnedButton({ view }: { view: MessageActionView }) {
  const faded = view.dimmed ? "opacity-50" : ""
  if (view.link && view.disabled === undefined)
    return (
      <Tooltip label={view.hint}>
        {cloneElement(view.link as ReactElement<Record<string, unknown>>, {
          "aria-label": view.label,
          className: `${iconButtonClass(view.tone === "danger" ? "danger" : "muted")} ${faded}`,
          children: <Icon name={view.icon} />
        })}
      </Tooltip>
    )
  return (
    <IconButton
      label={view.label}
      hint={view.disabled ?? view.hint}
      icon={view.icon}
      tone={view.tone === "danger" ? "danger" : "muted"}
      className={faded}
      disabled={view.disabled !== undefined}
      focusableWhenDisabled
      onClick={() => void view.onSelect?.()}
    />
  )
}

/** The checkbox's explanation: what pinning does, and why a pinned one isn't on this message. */
const pinHint = (label: string, pinned: boolean, shown: boolean) =>
  !pinned
    ? `Show ${label} as a button on each message it applies to, not only in this menu.`
    : shown
      ? `${label} shows as a button on each message it applies to. Untick to keep it only in this menu.`
      : `${label} shows as a button on each message it applies to, where there's room: this message's row is full. Untick to keep it only in this menu.`

/**
 * How many of the pinned buttons fit beside "More actions" in the toolbar's width: the toolbar
 * never wraps the message or scrolls sideways, so the rest stay in the menu (where every
 * action is anyway) until the row is wider. Buttons measure as rendered; a hidden one by its
 * last width, or an icon button's.
 */
function useFit(pinned: string) {
  const root = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const element = root.current
    if (element === null) return
    const widths = new WeakMap<Element, number>()
    const measure = () => {
      const more = element.querySelector<HTMLElement>(":scope > [data-more]")
      let room = element.clientWidth - (more?.offsetWidth ?? 32)
      let count = 0
      for (const item of element.querySelectorAll<HTMLElement>(":scope > [data-pin]")) {
        const shown = item.dataset.pin === "shown"
        const width = shown ? item.offsetWidth : (widths.get(item) ?? 32)
        if (shown) widths.set(item, width)
        if (width > room) break
        room -= width
        count += 1
      }
      setFit(count)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [pinned])
  return { root, fit }
}

export function MessageActions({ context, className = "" }: { context: MessageActionContext; className?: string }) {
  // Availability can depend on the path tip even when this row's entry stayed identical.
  const readTip = () => {
    const view = context.session.snapshot()
    // The first message shown, too: only it offers Insert message above.
    return `${view.forkId}:${view.loading}:${view.newer}:${view.older}:${view.entries[0]?.slotId}:${view.entries.at(-1)?.slotId}`
  }
  useSyncExternalStore(context.session.subscribe, readTip, readTip)
  const snapshot = useSyncExternalStore(messageActions.subscribe, messageActions.snapshot, messageActions.snapshot)
  const pins = useSyncExternalStore(messageActionPins.subscribe, messageActionPins.snapshot, messageActionPins.snapshot)
  const actions = availableMessageActions(context, snapshot)
  const pinned = actions.filter((action) => isPinned(action, pins.choices))
  const { root, fit } = useFit(pinned.map((action) => action.id).join(" "))
  const [dialog, setDialog] = useState<MessageAction | null>(null)
  const activeDialog = dialog !== null && actions.includes(dialog) ? dialog : null
  if (dialog !== null && activeDialog === null) setDialog(null)
  const explain = (action: MessageAction, view: MessageActionView): MessageActionView => {
    const reason = action.disabled?.(context)
    return reason ? { ...view, disabled: reason } : view
  }
  const props: MessageActionProps = {
    ...context,
    openDialog: (id: string) => setDialog(messageActions.get(id) ?? null),
    closeDialog: () => setDialog(null)
  }
  return (
    <div ref={root} role="toolbar" aria-label="Message actions" className={`min-w-0 flex-1 items-center ${className}`}>
      {pinned.map((action, index) => (
        <span
          key={action.id}
          data-pin={index < fit ? "shown" : "hidden"}
          className={index < fit ? "inline-flex shrink-0" : "hidden"}
        >
          <action.describe {...props} show={(view) => <PinnedButton view={explain(action, view)} />} />
        </span>
      ))}
      {actions.length > 0 && (
        <span data-more className="inline-flex shrink-0">
          <Menu
            align="end"
            label="More actions"
            trigger={
              <Tooltip label="More actions: every action on this message, and which show on it as buttons">
                <button type="button" aria-label="More actions" className={iconButtonClass()}>
                  <Icon name="more" />
                </button>
              </Tooltip>
            }
          >
            {actions.map((action, index) => {
              const on = isPinned(action, pins.choices)
              const shown = on && pinned.indexOf(action) < fit
              return (
                <Fragment key={action.id}>
                  {index > 0 && action.group !== actions[index - 1]!.group && <MenuSeparator />}
                  <action.describe
                    {...props}
                    show={(described) => {
                      const view = explain(action, described)
                      return (
                        <MenuItemWithCheckbox
                          icon={view.icon}
                          tone={view.tone ?? "default"}
                          label={view.label}
                          description={view.disabled ?? view.hint}
                          {...(view.disabled !== undefined ? { disabled: true, note: view.disabled } : {})}
                          {...(view.link ? { link: view.link } : {})}
                          {...(view.onSelect ? { onSelect: () => void view.onSelect?.() } : {})}
                          checkbox={{
                            checked: on,
                            onCheckedChange: (checked) => messageActionPins.choose(action.id, checked),
                            label: `Show ${view.label} on the message`,
                            description: pinHint(view.label, on, shown)
                          }}
                        />
                      )
                    }}
                  />
                </Fragment>
              )
            })}
            {pins.error !== null && (
              <p role="alert" className="px-2.5 py-1.5 text-xs text-danger">
                Couldn't save which actions show on messages: {pins.error}
              </p>
            )}
          </Menu>
        </span>
      )}
      {activeDialog?.dialog && <activeDialog.dialog {...props} />}
    </div>
  )
}
