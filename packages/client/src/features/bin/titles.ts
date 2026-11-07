// Bin labels use the whole chat title, including quotes inside a group name.
import type { BinItem, RecoveredText } from "@rp/shared/bin.ts"
import { readableChatTitle } from "../chat/chatTitle.ts"

export const binTitle = (item: BinItem) => {
  if (typeof item.origin.groupId === "string") return item.title
  if (item.kind === "chat") return item.title === "" ? "Untitled chat" : readableChatTitle(item.title)
  const chat = typeof item.origin.chatTitle === "string" ? readableChatTitle(item.origin.chatTitle) : null
  if (chat === null) return item.title
  // Numbered as the chat numbered it where it was deleted (its position from 1, which inserted
  // messages above it move off its depth); older items have only the depth, or neither.
  const place = typeof item.origin.position === "number" ? item.origin.position : item.origin.depth
  const number = typeof place === "number" ? place + 1 : null
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
        if (name !== null) return `Branch “${name}” in “${chat}”`
        return typeof only === "number" && only > 0
          ? `Branch of ${only} message${only === 1 ? "" : "s"} in “${chat}”`
          : `Branch in “${chat}”`
      }
      const count = item.origin.messages
      return typeof count === "number"
        ? `Branch of ${count} message${count === 1 ? "" : "s"} in “${chat}”`
        : `Branch in “${chat}”`
    }
    case "card_asset":
    case "entity":
    case "connection":
      return item.title
  }
}

/**
 * The question a "delete for good" confirmation asks: what goes, in plain words, without the
 * chat (the dialog names it in its body), so no title nests inside another's quotes.
 */
export const purgeTitle = (item: BinItem) => {
  const place = typeof item.origin.position === "number" ? item.origin.position : item.origin.depth
  const number = typeof place === "number" ? place + 1 : null
  const message = number === null ? "a message" : `message ${number}`
  switch (item.kind) {
    case "message":
      return number === null ? "Delete this message for good?" : `Delete message ${number} for good?`
    case "version": {
      // Numbered among the message's versions, from 1.
      const ordinal = typeof item.origin.ordinal === "number" ? item.origin.ordinal + 1 : null
      return ordinal === null
        ? `Delete a version of ${message} for good?`
        : `Delete version ${ordinal} of ${message} for good?`
    }
    case "branch": {
      const name = typeof item.origin.forkName === "string" && item.origin.forkName !== "" ? item.origin.forkName : null
      if (name !== null) return `Delete the branch “${name}” for good?`
      const count = item.origin.messages
      return typeof count === "number" && count > 0
        ? `Delete a branch of ${count} message${count === 1 ? "" : "s"} for good?`
        : "Delete this branch for good?"
    }
    case "chat":
      return `Delete the chat “${binTitle(item)}” for good?`
    case "entity":
    case "connection":
      return item.title === "" ? "Delete this for good?" : `Delete “${item.title}” for good?`
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
    entity_field: null,
    remote_card: null
  }
  const prefix = prefixes[text.sourceKind]
  if (prefix === null || !text.sourceLabel.startsWith(`${prefix}"`) || !text.sourceLabel.endsWith('"'))
    return text.sourceLabel
  const title = text.sourceLabel.slice(prefix.length + 1, -1)
  return `${prefix}“${readableChatTitle(title)}”`
}
