import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
// ⋯ Export's formats (chatExport.tsx): which files a chat's kind makes. The server writes them
// (importer/chatExport.ts).
import type { ChatView } from "./session.ts"

export type ExportFormat = "txt" | "jsonl"

/** Unknown or disabled kinds offer no export until their profile is installed. */
export const exportFormats = (view: ChatView): ReadonlyArray<ExportFormat> =>
  view.chat ? (chatKinds.get(view.chat.kind)?.exportFormats ?? []) : []
