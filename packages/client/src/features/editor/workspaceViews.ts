// Views a feature supplies for the chat's large editor (owner, 2026-11-02: a snippet or a note
// open in the centre column while the side panel shows other text). The workspace opens a
// library entry over the chat's column with `editor` and `focus` in the URL; when a view is
// registered under that `focus`, it's shown in place of the library editor, so a plugin can
// add, replace or disable one.
import type { RefId } from "@rp/shared/library.ts"
import type { ComponentType } from "react"
import { makeRegistry } from "../../registry.ts"
import type { ChatSession, ChatView } from "../chat/session.ts"

export interface WorkspaceViewProps {
  readonly refId: RefId
  /** Over a chat: back to it. On the library page there's nothing to close. */
  readonly onClose?: (() => void) | undefined
  /** The chat it's opened over, if any. */
  readonly session?: ChatSession | undefined
  readonly view?: ChatView | undefined
}

export interface WorkspaceView {
  /** The `focus` it's opened with. */
  readonly id: string
  /** The overlay's accessible name: what it edits. */
  readonly label: string
  /** Also shown on the entry's library page (`/library/$refId?focus=<id>`), outside a chat. */
  readonly page?: boolean
  readonly component: ComponentType<WorkspaceViewProps>
}

export const workspaceViews = makeRegistry<WorkspaceView>()

/** The view for a note opened large over a chat (`features/chat/ChatNotes.tsx`). */
export const NOTE_FOCUS = "note"
/** The view for a snippet opened large (`features/snippets/SnippetLarge.tsx`). */
export const SNIPPET_FOCUS = "snippet"
