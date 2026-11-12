import { chatKinds } from "@rp/shared/chatKinds.ts"
// ⋯ Export's file text (chatExport.tsx): the branch shown as ST's .jsonl or plain text.
import type { PathEntry } from "@rp/shared/chat.ts"
import { castCharacters, chatDisplayName } from "./chatTitle.ts"
import type { ChatView } from "./session.ts"

export type ExportFormat = "txt" | "jsonl"

/** Unknown or disabled kinds offer no export until their profile is installed. */
export const exportFormats = (view: ChatView): ReadonlyArray<ExportFormat> =>
  view.chat ? (chatKinds.get(view.chat.kind)?.exportFormats ?? []) : []

/** The file's text: who said what, as the chat shows it. */
export const exportText = (view: ChatView, entries: ReadonlyArray<PathEntry>, format: ExportFormat) => {
  if (!exportFormats(view).includes(format)) throw new Error("This chat kind does not support that export format.")
  const cards = view.cast?.cards ?? []
  const mine = new Set<string>(view.cast?.playedByMe ?? [])
  const persona = cards.find((c) => mine.has(c.entityId))?.name ?? "You"
  const speakerOf = (entry: PathEntry) => {
    const id = entry.version.speakerEntityId ?? entry.firstSpeakerEntityId
    const card = cards.find((c) => c.entityId === id)
    const user = id !== null && id !== undefined ? mine.has(id) : entry.version.writer === "human"
    return { name: card?.name ?? (user ? persona : "Model"), user }
  }
  if (format === "txt")
    return entries
      .map((entry) => `${speakerOf(entry).name}: ${entry.version.content}`)
      .join("\n\n")
      .concat("\n")
  const header = {
    user_name: persona,
    character_name: castCharacters(view)[0]?.name ?? chatDisplayName(view),
    create_date: new Date(view.chat?.createdAt ?? Date.now()).toISOString(),
    chat_metadata: {}
  }
  const lines = entries.map((entry) => {
    const { name, user } = speakerOf(entry)
    return {
      name,
      is_user: user,
      is_system: false,
      send_date: new Date(entry.version.createdAt).toISOString(),
      mes: entry.version.content,
      extra: {}
    }
  })
  return [header, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n"
}
