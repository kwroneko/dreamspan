// Chat panel contributions use the client registry's reversible registration scope.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { useNavigate } from "@tanstack/react-router"
import { Component, lazy, Suspense, useCallback, useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import { Button } from "../../ui/Button.tsx"
import type { IconName } from "../../ui/Icon.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import type { ChatSession, ChatView } from "./session.ts"

export interface PanelProps {
  readonly tab: string
  readonly active: boolean
  readonly session: ChatSession
  readonly view: ChatView
  readonly focus: string | null
  readonly notesFocus: EntityId | null
  readonly onSummaries: (summary: string) => void
  readonly onNotes: (card: EntityId) => void
  readonly onJump: (slot: SlotId) => void
  readonly onEnable: () => void
}

export interface PanelDescriptor {
  readonly id: string
  readonly label: string
  /** What the panel holds, on its tool tab's tooltip: "This chat's notes for the model", say. */
  readonly description?: string
  readonly order: number
  readonly icon: IconName
  readonly component: ComponentType<PanelProps>
  readonly available?: (view: ChatView) => boolean
  /**
   * Where its tabs go: "tools" (the default), a row of icons and labels that never wraps, what
   * doesn't fit under More; or "cast", the strip of the chat's characters, apart from the tools.
   */
  readonly placement?: "tools" | "cast"
  /** Dynamic tab families, such as the cast's cards. Exact registered IDs take precedence. */
  readonly matches?: (value: string) => boolean
  readonly tabs?: (view: ChatView, selected: string | null) => ReadonlyArray<PanelTabEntry>
  readonly default?: boolean
  readonly header?: boolean
  readonly preload?: () => void
}

/** One tab; in the cast strip it can carry a portrait, and a word such as "you". */
export interface PanelTabEntry {
  readonly value: string
  readonly label: string
  readonly avatar?: { readonly id: string; readonly name: string; readonly mediaId: string | null }
  readonly note?: string
}

export const chatPanels = makeRegistry<PanelDescriptor>()
export const useChatPanels = () => useSyncExternalStore(chatPanels.subscribe, chatPanels.snapshot, chatPanels.snapshot)
export const resolvePanel = (value: string, snapshot = chatPanels.snapshot()) => {
  if (snapshot.disabled.has(value)) return undefined
  const exact = snapshot.entries.find((entry) => entry.id === value)
  return exact && !exact.matches ? exact : snapshot.entries.find((entry) => entry.matches?.(value))
}
/** Without a view this validates stored syntax; with one it requires an offered tab. */
export const isPanelTab = (value: unknown, view?: ChatView, snapshot = chatPanels.snapshot()): value is string =>
  typeof value === "string" &&
  (view === undefined
    ? resolvePanel(value, snapshot) !== undefined
    : panelTabs(view, value, snapshot).some((tab) => tab.value === value))

export const panelTabs = (view: ChatView, selected: string | null, snapshot = chatPanels.snapshot()) =>
  [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter((entry) => entry.available?.(view) !== false)
    .flatMap((descriptor) =>
      (descriptor.tabs?.(view, selected) ?? [{ value: descriptor.id, label: descriptor.label }])
        .filter((tab) => resolvePanel(tab.value, snapshot) === descriptor)
        .map((tab) => ({ ...tab, descriptor }))
    )

/** Read the captured data so React Compiler retains the registry as a render dependency. */
export function usePanelTabs(view: ChatView, selected: string | null) {
  const snapshot = useChatPanels()
  return panelTabs(view, selected, snapshot)
}

/**
 * The tab to show for one asked for: itself when this chat offers it. A family's tab this chat
 * doesn't offer (another chat's character, carried by a link's `?panel=` or this browser's
 * memory) opens the panel's default tab instead, as a pick in the sidebar does; null otherwise.
 */
export const panelHere = (view: ChatView, value: string | null, snapshot = chatPanels.snapshot()) => {
  if (value === null) return null
  const tabs = panelTabs(view, value, snapshot)
  if (tabs.some((tab) => tab.value === value)) return value
  const family = resolvePanel(value, snapshot)?.matches !== undefined
  return (family && tabs.find((tab) => tab.descriptor.default)?.value) || null
}

export const usePanelHere = (value: string | null, view: ChatView) =>
  useSyncExternalStore(
    chatPanels.subscribe,
    () => panelHere(view, value),
    () => panelHere(view, value)
  )

export const useIsPanelTab = (value: unknown, view?: ChatView) =>
  useSyncExternalStore(
    chatPanels.subscribe,
    () => isPanelTab(value, view),
    () => isPanelTab(value, view)
  )

/** Shows another of the panel's tabs from inside one (a character's, from the Cast): the URL names the tab shown. */
export const useShowPanel = () => {
  const navigate = useNavigate()
  return useCallback(
    (panel: string) =>
      void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, panel }), replace: true }),
    [navigate]
  )
}

export function PanelContent({ descriptor, ...props }: PanelProps & { descriptor: PanelDescriptor }) {
  return <descriptor.component {...props} />
}

/** Each lazy contribution owns its retry boundary, including plugins. Failure stays in its tab. */
export const lazyPanel = (load: () => Promise<{ default: ComponentType<PanelProps> }>, label: string) => {
  return class LazyPanel extends Component<PanelProps> {
    override state = { failed: false, Content: lazy(load) }
    static getDerivedStateFromError() {
      return { failed: true }
    }
    override render() {
      if (this.state.failed)
        return (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-danger">
              The {label} couldn't be loaded: the server can't be reached.
            </p>
            <Button onClick={() => this.setState({ failed: false, Content: lazy(load) })}>Try again</Button>
          </div>
        )
      return (
        <Suspense fallback={<Loading label={`Loading the ${label}…`} />}>
          <this.state.Content {...this.props} />
        </Suspense>
      )
    }
  }
}
