// Bin labels use the whole chat title, including quotes inside a group name.
import type { BinItem, RecoveredText } from "@rp/shared/bin.ts"
import { readableChatTitle } from "../chat/chatTitle.ts"

export const binTitle = (item: BinItem) => {
  if (item.kind === "chat") return item.title === "" ? "Untitled chat" : readableChatTitle(item.title)
  const chat = typeof item.origin.chatTitle === "string" ? readableChatTitle(item.origin.chatTitle) : null
  if (chat === null) return item.title
  // Numbered as the chat numbers it (its depth from 1); items binned before origins kept it aren't.
  const number = typeof item.origin.depth === "number" ? item.origin.depth + 1 : null
  switch (item.kind) {
    case "message":
      return number === null ? `Message in “${chat}”` : `Message ${number} in “${chat}”`
    case "version":
      return number === null ? `Version of a message in “${chat}”` : `Version of message ${number} in “${chat}”`
    case "branch": {
      // A fork deleted on its own (owner, 2026-10-27): named by its name, else by what only it had.
      if (typeof item.origin.forkId === "string") {
        const name =
          typeof item.origin.forkName === "string" && item.origin.forkName !== "" ? item.origin.forkName : null
        const only = item.origin.messages
        if (name !== null) return `Fork “${name}” in “${chat}”`
        return typeof only === "number" && only > 0
          ? `Fork of ${only} message${only === 1 ? "" : "s"} in “${chat}”`
          : `Fork in “${chat}”`
      }
      const count = item.origin.messages
      return typeof count === "number"
        ? `Branch of ${count} message${count === 1 ? "" : "s"} in “${chat}”`
        : `Branch in “${chat}”`
    }
    case "entity":
    case "connection":
      return item.title
  }
}

/** Legacy recovered labels have a known prefix followed by ONE outer quoted title.
 * Use the source kind's format, so embedded quotes and unrelated library labels survive.
 */
export const recoveredSource = (text: Pick<RecoveredText, "sourceKind" | "sourceLabel">) => {
  const prefixes = {
    composer: "Composer in ",
    queue_edit: "Queued text in ",
    insert: "Inserted message in ",
    version_edit: "Edit of a message in ",
    scratchpad: "Scratchpad in ",
    summary_edit: "Summary in ",
    snippet: null,
    user_field: null,
    entity_field: null
  }
  const prefix = prefixes[text.sourceKind]
  if (prefix === null || !text.sourceLabel.startsWith(`${prefix}"`) || !text.sourceLabel.endsWith('"'))
    return text.sourceLabel
  const title = text.sourceLabel.slice(prefix.length + 1, -1)
  return `${prefix}“${readableChatTitle(title)}”`
}
