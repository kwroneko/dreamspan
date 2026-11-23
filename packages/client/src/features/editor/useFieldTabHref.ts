// The link of a field's own tab (fieldTab.ts), for the field's expand button.
import { type FieldPath, textField } from "@dreamspan/shared/editing.ts"
import { useNavigate } from "@tanstack/react-router"
import { useWorkbench, useWorkbenchTab } from "../workbench/tab.tsx"
import { fieldTabHref } from "./fieldTab.ts"
import { usePresetWorkspace } from "./PresetWorkspace.tsx"
import type { EditorStore } from "./store.ts"

/** A field's tab, for its expand link: where it goes, and a plain click's opening. */
export interface FieldTabLink {
  readonly href: string
  readonly open: () => void
}

/**
 * The tab for the field at `path` of `store`'s entry, or undefined where a field can't have one:
 * a chat's own note, edited at a branch's position, which a URL doesn't name. Opened from a
 * chat's stores, the tab is bound to that chat. A plain click keeps the tab it's opened from
 * (an italic preview would otherwise give its place to the field) and opens the field there,
 * or where a field's tab is showing (its kind opens where it's shown).
 */
export function useFieldTabHref(
  store: EditorStore,
  path: FieldPath,
  label: string,
  field = textField(path)
): FieldTabLink | undefined {
  const workspace = usePresetWorkspace()
  const workbench = useWorkbench()
  const tab = useWorkbenchTab()
  const navigate = useNavigate()
  if (store.chatNote) return undefined
  const fromChat = workspace?.chat !== undefined && [...workspace.edits.stores.values()].includes(store)
  const chat = fromChat ? new URL(workspace.href(store.refId), "http://tab.invalid").searchParams : null
  const href = fieldTabHref(
    { refId: store.refId, field, path, label },
    chat?.get("chat")
      ? {
          chat: chat.get("chat")!,
          chatFork: chat.get("chatFork") ?? undefined,
          chatTab: chat.get("chatTab") ?? undefined
        }
      : undefined
  )
  const open = () => {
    if (!workbench) return void navigate({ href })
    if (tab) workbench.pin(tab.tabId)
    workbench.openIn(tab ? workbench.frameOf(tab.tabId) : undefined, href)
  }
  return { href, open }
}
