// What the app's own drags carry (owner, 2026-11-07, DESIGN §10.1): a picture, a card or a chat,
// each a registered payload kind whose value is the tab URL a frame opens where it's dropped
// (features/workbench registers the three). A plugin adds a kind of its own the same way, or
// disables one; the frames open any kind they find. Whatever is dragged from inside the app is
// never a file from outside, so the composer never attaches it (`isAppDrag`).
import type { DragEvent } from "react"
import { makeRegistry } from "../registry.ts"

export interface DragPayloadKind {
  readonly id: string
  /** The drag's data type; its value is the tab URL to open. */
  readonly mime: string
}

export const dragPayloads = makeRegistry<DragPayloadKind>()

/**
 * A drag of the app's own portrait carries this, with the tab URL of its picture: a frame
 * opens it as a tab, and a chat's composer never takes it as an attachment.
 */
const PICTURE_TAB_MIME = "application/x-rp-picture-tab"

/** A portrait's picture: its picture tab (`/picture?…`). */
export const PICTURE_DRAG: DragPayloadKind = { id: "picture", mime: PICTURE_TAB_MIME }
/** A character: its card's full-size editor (`/library/<ref>`). */
export const CARD_DRAG: DragPayloadKind = { id: "card", mime: "application/x-rp-card-tab" }
/** A chat: the chat, on the branch its row opens. */
export const CHAT_DRAG: DragPayloadKind = { id: "chat", mime: "application/x-rp-chat-tab" }

const WIDE = "(min-width: 1024px)"

/**
 * Puts `href` on a drag as the payload of `kind` (an id in `dragPayloads`). Nothing on a phone:
 * it has one frame, and a long press there is the row's own (its menu, the browser's).
 */
export const carryOnDrag = (dataTransfer: DataTransfer, kind: string, href: string | null | undefined) => {
  const entry = dragPayloads.get(kind)
  if (!entry || !href || !matchMedia(WIDE).matches) return
  dataTransfer.setData(entry.mime, href)
}

/** A link's `onDragStart`: its own URL as the payload of `kind`, so a drop opens what its click does. */
export const carryLink = (kind: string) => (event: DragEvent<HTMLElement>) =>
  carryOnDrag(event.dataTransfer, kind, event.currentTarget.getAttribute("href"))

/**
 * The payload kind a drag carries, if any: its first registered kind. `href` is readable only
 * on the drop; while the drag is over, it's empty.
 */
export const dragPayloadOf = (dataTransfer: DataTransfer | null | undefined) => {
  if (!dataTransfer) return null
  const kind = dragPayloads.list().find((entry) => dataTransfer.types.includes(entry.mime))
  return kind ? { kind, href: dataTransfer.getData(kind.mime) } : null
}

// A drag that started in this page: a dragstart here, until it ends. A file from outside
// starts elsewhere, so no dragstart fires for it.
let fromPage = false
if (typeof window !== "undefined") {
  window.addEventListener("dragstart", () => (fromPage = true), true)
  window.addEventListener("dragend", () => (fromPage = false), true)
  // After the drop's own handlers; dragend may never come when its source left the page.
  window.addEventListener("drop", () => setTimeout(() => (fromPage = false)), true)
  window.addEventListener("pointerdown", () => (fromPage = false), true)
}

/**
 * Whether a drag comes from inside the app: one started in this page (a payload, a picture, a
 * link, selected text) or one carrying a payload kind (from another of the app's browser tabs).
 */
export const isAppDrag = (dataTransfer: DataTransfer | null | undefined) =>
  fromPage || dragPayloadOf(dataTransfer) !== null
