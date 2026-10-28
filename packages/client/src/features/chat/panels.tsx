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
export const resolvePanel = (value: string) => {
  const exact = chatPanels.get(value)
  return exact && !exact.matches ? exact : chatPanels.list().find((entry) => entry.matches?.(value))
}
export const isPanelTab = (value: unknown): value is string =>
  typeof value === "string" && resolvePanel(value) !== undefined

export const panelTabs = (view: ChatView, selected: string | null) =>
  [...chatPanels.list()]
    .sort((a, b) => a.order - b.order)
    .filter((entry) => entry.available?.(view) !== false)
    .flatMap((descriptor) =>
      (descriptor.tabs?.(view, selected) ?? [{ value: descriptor.id, label: descriptor.label }])
        .filter((tab) => resolvePanel(tab.value) === descriptor)
        .map((tab) => ({ ...tab, descriptor }))
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
