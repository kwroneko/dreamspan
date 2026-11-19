// Chat panel contributions use the client registry's reversible registration scope.
import type { EditorSnapshot } from "@dreamspan/shared/editorApi.ts"
import type { EntityId, SlotId } from "@dreamspan/shared/chat.ts"
import type { AvatarCrop } from "@dreamspan/shared/media.ts"
import { useNavigate } from "@tanstack/react-router"
import { Component, lazy, Suspense, useCallback, useSyncExternalStore, type ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import { kindHides } from "./kindLooks.ts"
import { Button } from "../../ui/Button.tsx"
import type { IconName } from "../../ui/Icon.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { isChunkLoadError, reportChunkFailure, StalePart, useStaleBuild } from "../../staleBuild.tsx"
import type { PendingChat } from "./pendingChat.ts"
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

/** What a tab's body is given in a chat not made yet (pendingChat.ts): the pending chat in place of a session. */
export interface PendingPanelProps {
  readonly tab: string
  readonly active: boolean
  readonly pending: PendingChat
  readonly view: ChatView
}

export interface PanelDescriptor {
  readonly id: string
  readonly label: string
  /** What the panel holds, on its tool tab's tooltip: "This chat's notes for the model", say. */
  readonly description?: string
  readonly order: number
  readonly icon: IconName
  readonly component: ComponentType<PanelProps>
  /** Which workspace editors belong to this tab, including edits in the large view. */
  readonly holdsEditor?: (ref: EditorSnapshot["ref"], tab: string) => boolean
  /**
   * Its body in a chat not made yet (before the first send). Without one the tab is still
   * there, in its place, and says it opens once the chat is saved.
   */
  readonly pending?: ComponentType<PendingPanelProps>
  /**
   * Offered only once the chat is saved: a chat not made yet leaves the tab out rather than
   * showing it in its place, for a tab whose content can't exist before the first send (the
   * Workshop tab: a workshop is attached to a saved chat).
   */
  readonly savedOnly?: boolean
  readonly available?: (view: ChatView) => boolean
  /**
   * Where its tabs go: "tools" (the default), a row of icons and labels that never wraps, what
   * doesn't fit under More; or "cast", the strip of the chat's characters, apart from the tools.
   */
  readonly placement?: "tools" | "cast"
  /**
   * How wide its body goes in a wide panel (owner, 2026-11-02: "Tabs should be able to fully
   * utilize horizontal space"): "full" (the default), the panel's whole width, its paragraphs
   * at a readable measure and its controls each at their own width; "readable", at most 52rem
   * from the left, for a body of controls that would only stretch.
   */
  readonly width?: "readable" | "full"
  /**
   * Its body fills the panel edge to edge, without the panel's padding or scrolling, for one that
   * scrolls a part of itself and keeps the rest in place: the Workshop tab's chat and composer.
   */
  readonly fill?: boolean
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
  readonly avatar?: {
    readonly id: string
    readonly name: string
    readonly mediaId: string | null
    readonly crop?: AvatarCrop | undefined
  }
  readonly note?: string
  /** Same-named cards keep their distinguishing text on compact strips. */
  readonly keepLabel?: boolean | undefined
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
    .filter(
      (entry) =>
        !(view.chat === null && entry.savedOnly) &&
        !kindHides(view.chat?.kind, entry.id) &&
        entry.available?.(view) !== false
    )
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
 * memory), or a saved-only tab before the first send, opens the registered default instead;
 * null otherwise.
 */
export const panelHere = (view: ChatView, value: string | null, snapshot = chatPanels.snapshot()) => {
  if (value === null) return null
  const tabs = panelTabs(view, value, snapshot)
  if (tabs.some((tab) => tab.value === value)) return value
  const descriptor = resolvePanel(value, snapshot)
  const fallback = descriptor?.matches !== undefined || (view.chat === null && descriptor?.savedOnly)
  return (fallback && tabs.find((tab) => tab.descriptor.default)?.value) || null
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
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, panel }),
        state: (prev) => ({ ...prev, chatPanel: true }),
        resetScroll: false
      }),
    [navigate]
  )
}

export function PanelContent({ descriptor, ...props }: PanelProps & { descriptor: PanelDescriptor }) {
  return <descriptor.component {...props} />
}

/** A tab's body in a chat not made yet: its pending body, or what it waits for. */
export function PendingPanelContent({ descriptor, ...props }: PendingPanelProps & { descriptor: PanelDescriptor }) {
  if (descriptor.pending) return <descriptor.pending {...props} />
  return (
    <p role="note" className="text-sm text-muted">
      Available once the chat is saved, when you send the first message.
    </p>
  )
}

/** Starts loading a lazy panel's code (`lazyPanel`), if it is one: the panel does this for every tab once it's open. */
export const preloadPanel = (component: ComponentType<PanelProps>) =>
  (component as { readonly preload?: () => void }).preload?.()

/**
 * Each lazy contribution owns its retry boundary, including plugins. Failure stays in its tab.
 * Once its code is loaded (`preload`, which the panel calls for every tab when it opens), a tab
 * mounts its content at once: through `lazy` it would show the fallback first, and React holds a
 * fallback on screen for at least 300 ms, so every first visit of a tab took half a second
 * however fast the code and its data came (night/tabperf).
 */
/**
 * A tab whose code failed to load. After a rebuild the old build's chunks are gone and Try
 * again can't work, so once the server's build is known to differ it asks for a reload.
 */
function PanelFailure({ label, chunk, retry }: { label: string; chunk: boolean; retry: () => void }) {
  const stale = useStaleBuild()
  if (stale) return <StalePart />
  return (
    <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-sm text-danger">
        {chunk ? `The ${label} couldn't be loaded: the server can't be reached.` : `The ${label} couldn't be shown.`}
      </p>
      <Button hint="Retries loading this view." onClick={retry}>
        Try again
      </Button>
    </div>
  )
}

export const lazyPanel = (load: () => Promise<{ default: ComponentType<PanelProps> }>, label: string) => {
  let loaded: ComponentType<PanelProps> | null = null
  let pending: Promise<{ default: ComponentType<PanelProps> }> | null = null
  const start = () =>
    (pending ??= load().then(
      (module) => {
        loaded = module.default
        return module
      },
      (error: unknown) => {
        // Asked again on Try again, or by the next preload.
        pending = null
        throw error
      }
    ))
  return class LazyPanel extends Component<PanelProps> {
    static preload() {
      void start().catch(() => undefined)
    }
    // Fixed for the mount, so the tree under it never changes shape (and its state stays).
    override state = { failed: false, chunk: false, Content: loaded ?? lazy(start) }
    static getDerivedStateFromError(error: unknown) {
      return { failed: true, chunk: isChunkLoadError(error) }
    }
    override componentDidCatch(error: unknown) {
      void reportChunkFailure(error)
    }
    override render() {
      if (this.state.failed)
        return (
          <PanelFailure
            label={label}
            chunk={this.state.chunk}
            retry={() => this.setState({ failed: false, chunk: false, Content: loaded ?? lazy(start) })}
          />
        )
      return (
        // Marked, so the performance harness can tell a tab that waited for its code.
        <Suspense
          fallback={
            <div data-panel-code-loading>
              <Loading label={`Loading the ${label}…`} />
            </div>
          }
        >
          <this.state.Content {...this.props} />
        </Suspense>
      )
    }
  }
}
