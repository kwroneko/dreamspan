// A message's actions, as registrations (spec/PLUGINS.md §8). Each one describes itself once
// (its name, icon, explanation and what choosing it does on this message) and owns its dialog.
// The host lists every available action in the message's "More actions" menu, in order, each
// with a checkbox that shows it as a button on the message too: the user's choices are kept
// by action id with the account's display preferences, over each action's own default, so a
// plugin's action can be pinned like a built-in one.
import type { BinItem } from "@dreamspan/shared/bin.ts"
import type { ForkId, PathEntry, VersionId } from "@dreamspan/shared/chat.ts"
import {
  cloneElement,
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode
} from "react"
import { makeRegistry } from "../../registry.ts"
import { usePlaceNotice, usePlaceParam } from "../../usePlaceParam.ts"
import { useChatPlaceKey } from "./chatPlace.ts"
import { MessageActionFit } from "./messageActionFit.ts"
import { showToast } from "../../ui/Toast.tsx"
import { useDeletedToast } from "../bin/deleted.ts"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { Menu, MenuItemWithCheckbox, MenuSeparator } from "../../ui/Menu.tsx"
import { linkMenuProps } from "../../ui/linkMenuState.ts"
import { IconButton, iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

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
  /**
   * Or where it goes: a link element (a router `Link`, without children) the row and button
   * render as. Its href gives both the link's open menu (Open, Open beside, Open in a new browser
   * tab; ui/LinkMenu.tsx) on a right-click.
   */
  readonly link?: ReactElement
}

export interface MessageActionDescribeProps extends MessageActionProps {
  /** Renders the action as the host places it: a menu row, or a button on the message. */
  readonly show: (view: MessageActionView) => ReactNode
}

export interface MessageAction {
  readonly id: string
  /** Built-in module provenance, following the other client registries. */
  readonly source?: string
  /** Its place in the menu, and on the message among the pinned. */
  readonly order: number
  /** Actions of one group sit together in the menu; a separator falls between groups. */
  readonly group?: string
  /** Whether this action applies to this kind of message. */
  readonly available?: (context: MessageActionContext) => boolean
  /**
   * Offered on a merged chat's entry too (spec/CHAT-MERGE.md §7). Off by default: that entry
   * isn't a message anyone wrote, so editing or generating versions of it means nothing.
   */
  readonly onMerges?: boolean
  /** Temporary unavailability keeps the button in place and explains why. */
  readonly disabled?: (context: MessageActionContext) => string | null
  /** Shown on the message as a button until the user unticks it. */
  readonly pinned?: boolean
  /** Still usable while the message or its thinking is edited: it only reads the saved message. */
  readonly duringEdit?: boolean
  /** The keyboard's (and a double-click's) way in, where it has one. */
  readonly run?: (context: MessageActionContext, source: "button" | "keyboard") => void | Promise<void>
  /**
   * Calls `show` with its view on this message. A component, so the view may follow state
   * (a hook); `viewOf` makes one from a plain function.
   */
  readonly describe: ComponentType<MessageActionDescribeProps>
  readonly dialog?: ComponentType<MessageActionProps>
  /** Keeps its dialog open across a reload: the URL names the action and the message version. */
  readonly dialogInUrl?: boolean
}

/** A `describe` from a function of the message: for the actions whose view needs no state. */
export const viewOf = (view: (props: MessageActionProps) => MessageActionView) =>
  function Describe({ show, ...props }: MessageActionDescribeProps) {
    return show(view(props))
  }

export const messageActions = makeRegistry<MessageAction>()

/**
 * What a message's delete toast offers after Undo (spec/PLUGINS.md §8): threads offer to delete a
 * copy of the message sent to another thread too (spec/THREADS.md §6.3).
 */
export interface MessageDeleteOffer {
  readonly id: string
  readonly order: number
  readonly actions: (
    context: DeleteOfferContext,
    item: BinItem
  ) => ReadonlyArray<{ readonly label: string; readonly hint?: string; readonly onClick: () => void }>
}
export const messageDeleteOffers = makeRegistry<MessageDeleteOffer>()

/** The message deleted, and the host's toast for anything an offer deletes in turn. */
export interface DeleteOfferContext extends Pick<MessageActionContext, "entry" | "session"> {
  readonly deleted: (item: BinItem) => void
}

/** Everything the registered offers add to the toast of `item`, deleted from `entry`. */
export const deleteOffersFor = (context: DeleteOfferContext, item: BinItem) =>
  [...messageDeleteOffers.snapshot().entries]
    .sort((a, b) => a.order - b.order)
    .flatMap((offer) => offer.actions(context, item))
export const availableMessageActions = (context: MessageActionContext, snapshot = messageActions.snapshot()) =>
  [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter(
      (entry) =>
        (context.entry.version.origin !== "merge" || entry.onMerges === true) && entry.available?.(context) !== false
    )

/** Resolve the effective action, including plugin disablement and availability. */
export const invokeMessageAction = (id: string, context: MessageActionContext, source: "button" | "keyboard") => {
  const action = messageActions.get(id)
  if (action?.available?.(context) === false || action?.disabled?.(context)) return
  if (context.entry.version.origin === "merge" && action?.onMerges !== true) return
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
          ...linkMenuProps,
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
 * action is anyway) until the row is wider. PinnedButton and More actions both use the
 * same icon button size. ResizeObserver supplies both widths without forcing
 * a layout for every message while React is still mounting the other rows.
 */
function useFit(pinned: string, count: number) {
  const root = useRef<HTMLDivElement>(null)
  const [measurement] = useState(() => new MessageActionFit())
  const fit = useSyncExternalStore(
    measurement.subscribe,
    () => measurement.visible(count),
    () => count
  )
  useEffect(() => {
    const element = root.current
    if (element === null) return
    const more = element.querySelector<HTMLElement>(":scope > [data-more]")
    const measure = (width: number, button: number) =>
      measurement.setCapacity(Math.max(0, Math.floor((width - button) / button)))
    if (typeof ResizeObserver === "undefined") {
      measure(element.clientWidth, more?.offsetWidth || 32)
      return
    }
    let width = 0
    let button = 32
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === element) width = entry.contentRect.width
        else if (entry.contentRect.width > 0) button = entry.contentRect.width
      }
      measure(width, button)
    })
    observer.observe(element)
    if (more) observer.observe(more)
    return () => observer.disconnect()
  }, [measurement, pinned])
  return { root, fit }
}

export function MessageActions({
  context,
  className = "",
  locked
}: {
  context: MessageActionContext
  className?: string
  /**
   * Why the actions can't be used now (the message or its thinking is edited): each one that
   * would change the message, and More actions, stays in its place disabled, saying this on hover.
   */
  locked?: string | undefined
}) {
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
  const { root, fit } = useFit(pinned.map((action) => action.id).join(" "), pinned.length)
  const [dialog, setDialog] = useState<MessageAction | null>(null)
  const [, setPlace] = usePlaceParam(useChatPlaceKey("messageDialog"), "")
  const versionId = context.entry.version.id
  const activeDialog = dialog !== null && actions.includes(dialog) ? dialog : null
  if (dialog !== null && activeDialog === null) setDialog(null)
  // A menu closed by a press outside it gives focus back to nothing: the press went elsewhere,
  // and focus coming back to More actions after the closing showed the buttons again once they
  // had faded with the menu (owner, 2026-11-24). Closed any other way (Escape, an item), focus
  // goes back, and the buttons are held shown until it is there.
  const closedOutside = useRef(false)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!held) return
    const timer = setTimeout(() => setHeld(false), 600)
    return () => clearTimeout(timer)
  }, [held])
  const explain = (action: MessageAction, view: MessageActionView): MessageActionView => {
    if (locked !== undefined && action.duringEdit !== true) return { ...view, disabled: locked }
    const reason = action.disabled?.(context)
    return reason ? { ...view, disabled: reason } : view
  }
  const props: MessageActionProps = {
    ...context,
    openDialog: (id: string) => {
      const action = messageActions.get(id) ?? null
      if (action?.dialogInUrl === true) setPlace(`${id}:${versionId}`)
      else setDialog(action)
    },
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
          {index < fit && <action.describe {...props} show={(view) => <PinnedButton view={explain(action, view)} />} />}
        </span>
      ))}
      {actions.length > 0 && (
        <span data-more data-held={held || undefined} className="inline-flex shrink-0" onFocus={() => setHeld(false)}>
          {locked !== undefined ? (
            <IconButton
              label="More actions"
              hint={locked}
              icon="more"
              disabled
              focusableWhenDisabled
              onClick={() => {}}
            />
          ) : (
            <Menu
              align="end"
              label="More actions"
              onOpenChange={(open, reason) => {
                closedOutside.current = !open && reason === "outside-press"
                setHeld(!open && !closedOutside.current)
              }}
              finalFocus={() => !closedOutside.current}
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
          )}
        </span>
      )}
      {activeDialog?.dialog && <activeDialog.dialog {...props} />}
    </div>
  )
}

/** One host outside the virtualized rows: the URL selects its action and exact version. */
export function MessageActionDialog({ session, view }: { session: ChatSession; view: ChatView }) {
  const snapshot = useSyncExternalStore(messageActions.subscribe, messageActions.snapshot, messageActions.snapshot)
  const [place, setPlace] = usePlaceParam(useChatPlaceKey("messageDialog"), "")
  const split = place.lastIndexOf(":")
  const id = split > 0 ? place.slice(0, split) : ""
  const versionId = split > 0 ? place.slice(split + 1) : ""
  const action = snapshot.entries.find((entry) => entry.dialogInUrl === true && entry.id === id)
  usePlaceNotice(place !== "" && (!action?.dialog || !versionId) ? "This message dialog is no longer available." : null)
  if (!action?.dialog || !versionId) return null
  return (
    <LoadedMessageDialog
      key={`${session.id}/${view.forkId}/${place}`}
      session={session}
      action={action}
      versionId={versionId as VersionId}
      setPlace={setPlace}
    />
  )
}

function LoadedMessageDialog({
  session,
  action,
  versionId,
  setPlace
}: {
  session: ChatSession
  action: MessageAction
  versionId: VersionId
  setPlace: (place: string) => void
}) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const [loaded, setLoaded] = useState<Outcome<PathEntry> | null>(null)
  const deleted = useDeletedToast()
  const forkId = view.forkId
  useEffect(() => {
    if (forkId === null) return
    let active = true
    void session
      .call((client) => client("ReadMessageVersion", { chatId: session.id, forkId, versionId }))
      .then((result) => {
        if (active) setLoaded(result)
      })
    return () => {
      active = false
    }
  }, [session, forkId, versionId])
  usePlaceNotice(loaded?.ok === false ? loaded.error.message : null)
  const entry = view.entries.find((entry) => entry.version.id === versionId) ?? (loaded?.ok ? loaded.value : null)
  const report = (outcome: Outcome<unknown>) => {
    if (!outcome.ok) showToast({ title: outcome.error.message })
  }
  const context: MessageActionContext | null =
    entry === null
      ? null
      : {
          entry,
          session,
          branchFork: forkId,
          generated: entry.version.writer === "model",
          generating: entry.version.status === "generating",
          hidden: entry.contextExcluded,
          report,
          toast: (outcome) => {
            if (outcome.ok)
              deleted(
                outcome.value,
                undefined,
                deleteOffersFor({ entry, session, deleted: (item) => deleted(item) }, outcome.value)
              )
            else report(outcome)
          }
        }
  const available = context !== null && availableMessageActions(context).includes(action)
  usePlaceNotice(context !== null && !available ? "This message dialog is no longer available." : null)
  if (context === null || !available || !action.dialog) return null
  return (
    <action.dialog {...context} openDialog={(id) => setPlace(`${id}:${versionId}`)} closeDialog={() => setPlace("")} />
  )
}
