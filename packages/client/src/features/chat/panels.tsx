// Chat panel contributions use the client registry's reversible registration scope.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { Component, lazy, Suspense, useSyncExternalStore, type ComponentType } from "react"
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
  readonly onNotes: (card: EntityId) => void
  readonly onJump: (slot: SlotId) => void
  readonly onEnable: () => void
}

export interface PanelDescriptor {
  readonly id: string
  readonly label: string
  readonly order: number
  readonly icon: IconName
  readonly component: ComponentType<PanelProps>
  readonly available?: (view: ChatView) => boolean
  /** Dynamic tab families, such as the cast's cards. Exact registered IDs take precedence. */
  readonly matches?: (value: string) => boolean
  readonly tabs?: (view: ChatView, selected: string | null) => ReadonlyArray<{ value: string; label: string }>
  readonly default?: boolean
  readonly header?: boolean
  readonly preload?: () => void
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

export const useIsPanelTab = (value: unknown, view?: ChatView) =>
  useSyncExternalStore(
    chatPanels.subscribe,
    () => isPanelTab(value, view),
    () => isPanelTab(value, view)
  )

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
