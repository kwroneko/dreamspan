// A field of a library entry in a workbench tab of its own (owner, 2026-11-23: the text box's
// expand button "opens Description in its own tab"): `/library/<ref>/field?field=…&label=…`,
// the field's editor filling the tab, the same store and draft as the field in its editor, so
// edits in one show in the other. Opened from a chat (its panel, or an editor bound to it), the
// URL names the chat as the entry's editor tab does (`chat`, `chatFork`, `chatTab`), and the tab
// edits through that chat's stores while it's open. A field inside a value (an alternate
// greeting, its list's item) names its list's draft field and its own path (`path`).
//
// A chat's own texts open the same way (owner, 2026-11-23: no expand is lost), under the chat
// that owns them: a chat's own note at `/chats/<chat>/notes/<ref>/field?…&fork=…&slot=…` (the
// branch position it's edited at), a summary's text at `/chats/<chat>/summaries/<id>/text?fork=…`
// and the chat's summarization instruction at `/chats/<chat>/instruction?fork=…&leaf=…`.
import type { ChatNotePosition } from "@dreamspan/shared/editorApi.ts"
import { type FieldPath, parseField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import type { TabKind } from "../workbench/kinds.ts"

const FIELD_TAB_PATH = /^\/library\/([^/]+)\/field$/
const NOTE_TAB_PATH = /^\/chats\/([^/]+)\/notes\/([^/]+)\/field$/
const SUMMARY_TAB_PATH = /^\/chats\/([^/]+)\/summaries\/([^/]+)\/text$/
const INSTRUCTION_TAB_PATH = /^\/chats\/([^/]+)\/instruction$/

export interface FieldTabTarget {
  readonly refId: RefId
  /** The draft field its text is kept in (`textField`, or a list's `valueField`). */
  readonly field: string
  /** Where the text is in the document. */
  readonly path: FieldPath
  /** What the field is called: the tab's title after the entry's name, and its box's label. */
  readonly label: string
  /** A chat's own note: the branch position it's edited at. */
  readonly chatNote?: ChatNotePosition | undefined
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
  const note = target.chatNote
  if (note) {
    if (note.forkId) params.set("fork", note.forkId)
    if (note.slotId) params.set("slot", note.slotId)
    return `/chats/${encodeURIComponent(note.chatId)}/notes/${encodeURIComponent(target.refId)}/field?${params.toString()}`
  }
  if (chat) {
    params.set("chat", chat.chat)
    if (chat.chatFork) params.set("chatFork", chat.chatFork)
    if (chat.chatTab) params.set("chatTab", chat.chatTab)
  }
  return `/library/${encodeURIComponent(target.refId)}/field?${params.toString()}`
}

const decoded = (part: string | undefined) => {
  if (part === undefined) return null
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
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
  const note = NOTE_TAB_PATH.exec(url.pathname)
  const ref = note ? note[2] : FIELD_TAB_PATH.exec(url.pathname)?.[1]
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
  const refId = decoded(ref)
  if (refId === null) return null
  const label = url.searchParams.get("label")?.trim() || "Field"
  if (!note) return { refId: refId as RefId, field, path, label }
  const chatId = decoded(note[1])
  if (chatId === null) return null
  const chatNote = {
    chatId,
    forkId: url.searchParams.get("fork") || null,
    slotId: url.searchParams.get("slot") || null
  } as ChatNotePosition
  return { refId: refId as RefId, field, path, label, chatNote }
}

/** A summary's text in its own tab: the chat, the branch it's read on, the summary. */
export interface SummaryTabTarget {
  readonly chatId: string
  readonly forkId: string | null
  readonly summaryId: string
  /** What the summary covers, as its box names it: "Summary of messages 1–20". */
  readonly label: string
}

export const summaryTabHref = (target: SummaryTabTarget) => {
  const params = new URLSearchParams()
  if (target.forkId) params.set("fork", target.forkId)
  params.set("label", target.label)
  return `/chats/${encodeURIComponent(target.chatId)}/summaries/${encodeURIComponent(target.summaryId)}/text?${params.toString()}`
}

export const summaryTabTarget = (url: URL): SummaryTabTarget | null => {
  const match = SUMMARY_TAB_PATH.exec(url.pathname)
  const chatId = decoded(match?.[1])
  const summaryId = decoded(match?.[2])
  if (chatId === null || summaryId === null) return null
  return {
    chatId,
    forkId: url.searchParams.get("fork") || null,
    summaryId,
    label: url.searchParams.get("label")?.trim() || "Summary"
  }
}

/** A chat's summarization instruction in its own tab: the chat, and the branch and leaf it's set at. */
export interface InstructionTabTarget {
  readonly chatId: string
  readonly forkId: string | null
  readonly leafSlotId: string | null
}

export const INSTRUCTION_LABEL = "Summarization instruction"

export const instructionTabHref = (target: InstructionTabTarget) => {
  const params = new URLSearchParams()
  if (target.forkId) params.set("fork", target.forkId)
  if (target.leafSlotId) params.set("leaf", target.leafSlotId)
  const query = params.toString()
  return `/chats/${encodeURIComponent(target.chatId)}/instruction${query ? `?${query}` : ""}`
}

export const instructionTabTarget = (url: URL): InstructionTabTarget | null => {
  const chatId = decoded(INSTRUCTION_TAB_PATH.exec(url.pathname)?.[1])
  if (chatId === null) return null
  return {
    chatId,
    forkId: url.searchParams.get("fork") || null,
    leafSlotId: url.searchParams.get("leaf") || null
  }
}

/**
 * The tab kind's item: one tab per entry and field (a chat's own note per branch position too),
 * per summary and branch, per chat and branch for the instruction.
 */
export const fieldTabKey = (url: URL) => {
  const target = fieldTabTarget(url)
  if (target) {
    const note = target.chatNote
    const at = note ? `\nnote:${note.chatId}:${note.forkId ?? ""}:${note.slotId ?? ""}` : ""
    return `${target.refId}\n${JSON.stringify(target.path)}${at}`
  }
  const summary = summaryTabTarget(url)
  if (summary) return `summary:${summary.chatId}:${summary.forkId ?? ""}:${summary.summaryId}`
  const instruction = instructionTabTarget(url)
  if (instruction) return `instruction:${instruction.chatId}:${instruction.forkId ?? ""}`
  return null
}

/** The tab's title until its entry has loaded. */
export const fieldTabTitle = (url: URL) =>
  fieldTabTarget(url)?.label ??
  summaryTabTarget(url)?.label ??
  (instructionTabTarget(url) ? INSTRUCTION_LABEL : "Field")

/** The tab's title: "<entry> · <field>". */
export const fieldTabName = (entry: string, label: string) => (entry ? `${entry} · ${label}` : label)

/**
 * The tab kind: one tab per entry and field (or chat text), a document (typing keeps it), and a
 * second field opens where a field's tab is showing (as request inspectors do), not over the
 * editor or the chat.
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
