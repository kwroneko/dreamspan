// The link of a field's own tab (fieldTab.ts), for the field's expand button.
import { type FieldPath, textField } from "@dreamspan/shared/editing.ts"
import { fieldTabHref } from "./fieldTab.ts"
import { type FieldTabLink, useFieldTabLink } from "./openFieldTab.ts"
import { usePresetWorkspace } from "./PresetWorkspace.tsx"
import type { EditorStore } from "./store.ts"

export type { FieldTabLink } from "./openFieldTab.ts"

/**
 * The tab for the field at `path` of `store`'s entry. Opened from a chat's stores, the tab is
 * bound to that chat; a chat's own note names the branch position it's edited at.
 */
export function useFieldTabHref(
  store: EditorStore,
  path: FieldPath,
  label: string,
  field = textField(path)
): FieldTabLink {
  const workspace = usePresetWorkspace()
  const fromChat =
    !store.chatNote && workspace?.chat !== undefined && [...workspace.edits.stores.values()].includes(store)
  const chat = fromChat ? new URL(workspace.href(store.refId), "http://tab.invalid").searchParams : null
  const href = fieldTabHref(
    { refId: store.refId, field, path, label, chatNote: store.chatNote },
    chat?.get("chat")
      ? {
          chat: chat.get("chat")!,
          chatFork: chat.get("chatFork") ?? undefined,
          chatTab: chat.get("chatTab") ?? undefined
        }
      : undefined
  )
  return useFieldTabLink(href)
}
