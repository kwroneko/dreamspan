// A field of a library entry in a workbench tab of its own (owner, 2026-11-23: the text box's
// expand button "opens Description in its own tab"): `/library/<ref>/field?field=…&label=…`,
// the field's editor filling the tab, the same store and draft as the field in its editor, so
// edits in one show in the other. Opened from a chat (its panel, or an editor bound to it), the
// URL names the chat as the entry's editor tab does (`chat`, `chatFork`, `chatTab`), and the tab
// edits through that chat's stores while it's open. A field inside a value (an alternate
// greeting, its list's item) names its list's draft field and its own path (`path`).
import { type FieldPath, parseField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import type { TabKind } from "../workbench/kinds.ts"

export const FIELD_TAB_PATH = /^\/library\/([^/]+)\/field$/

export interface FieldTabTarget {
  readonly refId: RefId
  /** The draft field its text is kept in (`textField`, or a list's `valueField`). */
  readonly field: string
  /** Where the text is in the document. */
  readonly path: FieldPath
  /** What the field is called: the tab's title after the entry's name, and its box's label. */
  readonly label: string
}

/** The chat a field's tab is opened from, as the entry's editor tab names it. */
export interface FieldTabChat {
  readonly chat: string
  readonly chatFork?: string | undefined
  readonly chatTab?: string | undefined
}

const samePath = (a: FieldPath, b: FieldPath) => a.length === b.length && a.every((part, i) => part === b[i])

/** The tab's URL. */
export const fieldTabHref = (target: FieldTabTarget, chat?: FieldTabChat) => {
  const params = new URLSearchParams()
  params.set("field", target.field)
  const parsed = parseField(target.field)
  if (!parsed || !samePath(parsed.path, target.path)) params.set("path", JSON.stringify(target.path))
  params.set("label", target.label)
  if (chat) {
    params.set("chat", chat.chat)
    if (chat.chatFork) params.set("chatFork", chat.chatFork)
    if (chat.chatTab) params.set("chatTab", chat.chatTab)
  }
  return `/library/${encodeURIComponent(target.refId)}/field?${params.toString()}`
}

const isPath = (value: unknown): value is FieldPath =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((part) => typeof part === "string" || (typeof part === "number" && Number.isSafeInteger(part)))

/**
 * What a field tab's URL names, or null when it isn't one or doesn't name a field: a text field,
 * or a list's value field with a path one item into it.
 */
export const fieldTabTarget = (url: URL): FieldTabTarget | null => {
  const ref = FIELD_TAB_PATH.exec(url.pathname)?.[1]
  const field = url.searchParams.get("field")
  if (ref === undefined || field === null) return null
  const parsed = parseField(field)
  if (!parsed) return null
  let path: FieldPath = parsed.path
  const given = url.searchParams.get("path")
  if (given !== null) {
    let value: unknown
    try {
      value = JSON.parse(given)
    } catch {
      return null
    }
    if (!isPath(value)) return null
    path = value
  }
  const item =
    parsed.kind === "value" &&
    path.length === parsed.path.length + 1 &&
    typeof path.at(-1) === "number" &&
    samePath(parsed.path, path.slice(0, -1))
  if (parsed.kind === "text" ? !samePath(parsed.path, path) : !item) return null
  let refId: string
  try {
    refId = decodeURIComponent(ref)
  } catch {
    return null
  }
  const label = url.searchParams.get("label")?.trim() || "Field"
  return { refId: refId as RefId, field, path, label }
}

/** The tab kind's item: one tab per entry and field. */
export const fieldTabKey = (url: URL) => {
  const target = fieldTabTarget(url)
  return target ? `${target.refId}\n${JSON.stringify(target.path)}` : null
}

/** The tab's title until its entry has loaded. */
export const fieldTabTitle = (url: URL) => fieldTabTarget(url)?.label ?? "Field"

/** The tab's title: "<entry> · <field>". */
export const fieldTabName = (entry: string, label: string) => (entry ? `${entry} · ${label}` : label)

/**
 * The tab kind: one tab per entry and field, a document (typing keeps it), and a second field
 * opens where a field's tab is showing (as request inspectors do), not over the editor.
 */
export const fieldTabKind: TabKind = {
  id: "library.field",
  order: 190,
  match: fieldTabKey,
  title: fieldTabTitle,
  icon: "expand",
  document: true,
  opensWhereShown: true
}
