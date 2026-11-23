// A pending chat has no ChatSession yet. Its controls share a registry and the same
// speaker/guidance contract, while chat creation remains lazy in the host.
import type { MessageImages } from "@dreamspan/shared/chat.ts"
import type { ComponentProps, ComponentType, DOMAttributes, ReactNode } from "react"
import { createContext, useContext, useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import type { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import type { ChatView } from "./session.ts"
import type { DraftPreviewState } from "./draftRequest.tsx"

export interface PendingComposerContext {
  /** A phone: the speaker chip is its portrait, Generate an icon, as at the chat's composer. */
  readonly compact: boolean
  readonly speaker: ComponentProps<typeof SpeakerSwitcher>
  readonly submitHint: string
  readonly speakerName: string
  readonly guidance: boolean
  readonly prefsReady: boolean
  readonly changeGuidance: (next: boolean) => void
  readonly busy: boolean
  /** Attachments still being added: the first send waits for them. */
  readonly attaching?: boolean
  /** Text typed, or something attached: there's a message to send. */
  readonly hasText: boolean
  readonly start: (first: "send" | "generate") => Promise<void>
  /** The pending chat as the saved chat's parts read it (pendingChat.ts). */
  readonly view: ChatView
  /** Opens the side panel at a tab, as the saved composer's chips do. */
  readonly onSettings: (tab: string) => void
  /** The first request, built as the box and the choices change (draftRequest.tsx). */
  readonly draft: DraftPreviewState
  /** The cards from a card source the first turn adds (spec/CARD-SOURCES.md §4.4), by name; empty for local cards. */
  readonly adds: string
}
interface PendingControl {
  readonly id: string
  readonly order: number
  /**
   * `notes`: a row of its own above the composer, for what the user should know before sending;
   * `strip`: the next-reply strip under the box, as at the saved chat's composer.
   */
  readonly placement: "notes" | "speaker" | "actions" | "guidance" | "strip"
  readonly component: ComponentType<PendingComposerContext>
  readonly run?: (context: PendingComposerContext) => Promise<void>
}
export const pendingComposerControls = makeRegistry<PendingControl>()

export const invokePendingComposer = (context: PendingComposerContext) =>
  pendingComposerControls.get(context.guidance ? "pending.generate" : "pending.send")?.run?.(context)

export function PendingComposerControls({
  placement,
  context
}: {
  placement: PendingControl["placement"]
  context: PendingComposerContext
}) {
  const snapshot = useSyncExternalStore(pendingComposerControls.subscribe, pendingComposerControls.snapshot)
  return [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter((entry) => entry.placement === placement)
    .map((entry) => <entry.component key={entry.id} {...context} />)
}

/**
 * What's attached to the first message of a chat not made yet, as at the saved composer
 * (images.tsx): the same paperclip, list, paste and drop. It's kept in this browser against the
 * pending chat's draft identity until the first send, which takes it into the chat.
 */
export interface PendingAttachments {
  readonly count: number
  /** Those uploaded, as the first send would take them (its request preview reads them). */
  readonly images: MessageImages
  /** Loading, adding or uploading: the first send waits. */
  readonly busy: boolean
  /** The paperclip, in the box's control row. */
  readonly action: ReactNode
  /** What's attached, under the text; `model` is the first request's (vision, last-N limit). */
  readonly editor: (model: { readonly vision?: boolean; readonly maxImages?: number } | undefined) => ReactNode
  /** Paste and drop anywhere on the page attach, as anywhere in a saved chat. */
  readonly surface: Pick<DOMAttributes<HTMLDivElement>, "onDragOver" | "onDrop" | "onPaste">
  /** What the first send takes; `finish(true)` once the chat holds them, `finish(false)` keeps them. */
  readonly capture: () => { readonly images: MessageImages; readonly finish: (sent: boolean) => Promise<void> }
  /** Moves what's still attached to the saved chat's composer (its fork's draft) once it's made. */
  readonly carry: (chatId: string, forkId: string) => Promise<void>
}
interface PendingAttachmentsPart {
  readonly id: string
  /** Provides `PendingAttachmentsContext` for the pending chat whose draft identity is `scope`. */
  readonly component: ComponentType<{ readonly scope: string; readonly children: ReactNode }>
}
/** @public The images feature registers the pending chat's attachments here; a plugin can replace it. */
export const pendingAttachments = makeRegistry<PendingAttachmentsPart>()
export const PendingAttachmentsContext = createContext<PendingAttachments | null>(null)
export const usePendingAttachments = () => useContext(PendingAttachmentsContext)

/** The pending chat's attachments, by the part in effect; without one, the composer takes text only. */
export function PendingAttachmentScope({ scope, children }: { scope: string; children: ReactNode }) {
  const snapshot = useSyncExternalStore(pendingAttachments.subscribe, pendingAttachments.snapshot)
  const part = snapshot.entries.at(-1)
  return part ? (
    <part.component key={part.id} scope={scope}>
      {children}
    </part.component>
  ) : (
    children
  )
}
