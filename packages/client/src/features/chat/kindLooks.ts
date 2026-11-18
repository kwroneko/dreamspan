// How a chat of each kind looks in the client (spec/WORKSHOP.md §2.1, §2.5): its badge, its accent
// and which registered chat controls it leaves out or adds. The kind's behaviour (planner, summaries,
// merges, export) is the shared profile (`@rp/shared/chatKinds.ts`); this is only its look, so a
// plugin's kind brings its own by registering both. A kind without a look looks like a story chat.
import { useSyncExternalStore, type CSSProperties } from "react"
import { chatKinds } from "@rp/shared/chatKinds.ts"
import { makeRegistry } from "../../registry.ts"

export interface ChatKindLook {
  readonly id: string
  /** The word on the chat wherever it's named, and its hover explanation. */
  readonly badge?: { readonly label: string; readonly hint: string }
  /**
   * The chat's accent: a token's name ("--accent-workshop"), with `<name>-contrast` for text on it.
   * The chat page makes it the accent of everything inside it.
   */
  readonly accent?: string
  /** Registered chat controls (composer controls, side-panel tabs, This chat sections, menu commands) it doesn't use, by id. */
  readonly hides: ReadonlyArray<string>
  /** Controls that exist only in kinds that ask for them, by id (the workshop's capability chip). */
  readonly shows?: ReadonlyArray<string>
}

export const chatKindLooks = makeRegistry<ChatKindLook>()

const NONE: ReadonlyArray<string> = []

const lookOf = (kind: string | undefined, snapshot = chatKindLooks.snapshot()) =>
  kind === undefined ? undefined : snapshot.entries.find((look) => look.id === kind)

/** Plain-text surfaces (browser tabs and notifications) carry the same kind label as badges. */
export const kindTitle = (title: string, kind: string | undefined) => {
  const badge = lookOf(kind)?.badge
  return badge ? `${badge.label} · ${title}` : title
}

/** Whether a chat of this kind leaves the control out. */
export const kindHides = (kind: string | undefined, id: string, snapshot = chatKindLooks.snapshot()) =>
  (lookOf(kind, snapshot)?.hides ?? NONE).includes(id)

/** Whether a chat of this kind asks for a control that's off elsewhere. */
export const kindShows = (kind: string | undefined, id: string, snapshot = chatKindLooks.snapshot()) =>
  (lookOf(kind, snapshot)?.shows ?? NONE).includes(id)

/** The chat root's attributes: its kind, and its accent as the custom properties styles.css reads. */
export const kindRootProps = (
  look: ChatKindLook | undefined
): { "data-chat-kind"?: string; "data-chat-accent"?: string; style?: CSSProperties } =>
  look === undefined ? {} : { "data-chat-kind": look.id, ...kindAccentProps(look) }

/** Just the accent, for a badge or a row inside a list: it isn't the chat's root, so it has no kind attribute. */
export const kindAccentProps = (
  look: ChatKindLook | undefined
): { "data-chat-accent"?: string; style?: CSSProperties } =>
  look?.accent === undefined
    ? {}
    : {
        "data-chat-accent": "",
        style: {
          "--chat-accent": `var(${look.accent})`,
          "--chat-accent-contrast": `var(${look.accent}-contrast)`
        } as CSSProperties
      }

/**
 * A list row of a chat whose kind has an accent: its kind and accent on the row, so what's inside
 * (its badge, its selected border) takes the kind's accent. No tint or edge: those read as selected
 * (owner, 2026-11-18). Nothing for a story.
 */
export const kindRowProps = (look: ChatKindLook | undefined) => {
  const accent = kindAccentProps(look)
  return accent["data-chat-accent"] === undefined ? {} : { ...accent, "data-kind-row": "" }
}

export function useChatKindLook(kind: string | undefined) {
  const snapshot = useSyncExternalStore(chatKindLooks.subscribe, chatKindLooks.snapshot, chatKindLooks.snapshot)
  return lookOf(kind, snapshot)
}

// What the kind's shared profile allows, for the controls that offer it; allowed until the chat is known.
type KindOf = { readonly kind: string } | null | undefined
/** Merging another chat into this one (the server refuses it into a workshop). */
export const mergesInto = (chat: KindOf) => chat == null || chatKinds.get(chat.kind)?.allowsMerge !== false
/** Turning summaries on (a workshop's stay off). */
export const summarizes = (chat: KindOf) => chat == null || chatKinds.get(chat.kind)?.allowsSummaries !== false
/** A workshop beside it, to talk about it out of character (a story's; not a workshop's). Only once the chat is known. */
export const takesSideChat = (chat: KindOf) => chat != null && chatKinds.get(chat.kind)?.allowsSideChat === true
