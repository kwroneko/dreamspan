// Sending an ST data folder to the server (ARCHITECTURE.md §13): which of the picked files
// go, in what order, and each one over HTTP, a chat in parts cut at line ends.
import {
  classifyStPath,
  findStRoots,
  orderStChats,
  ST_CHAT_PART_BYTES,
  ST_FILE_ORDER,
  type StFile,
  type StRoot
} from "@rp/shared/stFolder.ts"
import { StFileResult } from "@rp/shared/stImportApi.ts"
import { Schema } from "effect"
import { failure, type UploadOutcome } from "./files.ts"

export interface StFolderFile {
  readonly path: string
  readonly file: File
  readonly kind: StFile["kind"]
}

/** A picked file's path in the picked folder. */
const pathOf = (file: File) => file.webkitRelativePath || file.name

export const stRoots = (files: ReadonlyArray<File>): ReadonlyArray<StRoot> => findStRoots(files.map(pathOf))

/** The files of one user's folder the import reads, in the order they go, and those it lists unread. */
export const stPlan = (files: ReadonlyArray<File>, prefix: string) => {
  const send: Array<StFolderFile> = []
  const unsupported: Array<string> = []
  for (const file of files) {
    const path = pathOf(file)
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    const kind = classifyStPath(relative)?.kind
    if (kind === "unsupported") unsupported.push(relative)
    else if (kind !== undefined) send.push({ path: relative, file, kind })
  }
  send.sort((a, b) => ST_FILE_ORDER.indexOf(a.kind) - ST_FILE_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path))
  return { send, unsupported }
}

const isChat = (entry: StFolderFile) => entry.kind === "chat" || entry.kind === "group_chat"

/** The chat a branch file names as its parent (`main_chat`), from its first line. */
const mainChatOf = async (file: File) => {
  const head = await file.slice(0, 64 * 1024).text()
  try {
    const header: unknown = JSON.parse(head.split("\n", 1)[0]!)
    const metadata =
      typeof header === "object" && header !== null ? (header as Record<string, unknown>).chat_metadata : null
    const name =
      typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>).main_chat : null
    return typeof name === "string" && name !== "" ? name : null
  } catch {
    return null
  }
}

/** The plan's chats with each parent before its branches (`orderStChats`). */
export const orderBranches = async (send: ReadonlyArray<StFolderFile>) => {
  const chats: Array<StFolderFile & { readonly mainChat: string | null }> = []
  for (const entry of send) if (isChat(entry)) chats.push({ ...entry, mainChat: await mainChatOf(entry.file) })
  const ordered = orderStChats(chats)
  let next = 0
  return send.map((entry) => (isChat(entry) ? ordered[next++]! : entry))
}

const decode = Schema.decodeUnknownSync(StFileResult)

const post = async (
  query: URLSearchParams,
  body: Blob | Uint8Array<ArrayBuffer>
): Promise<UploadOutcome<StFileResult>> => {
  let response: Response
  try {
    response = await fetch(`/st-import/file?${query}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body
    })
  } catch {
    return { _tag: "Failed", message: "The upload didn't reach the server. Check that it's running." }
  }
  if (response.status === 401) return { _tag: "Unauthorized" }
  if (!response.ok) return { _tag: "Failed", message: await failure(response, "import the file") }
  try {
    return { _tag: "Done", result: decode(await response.json()) }
  } catch {
    return { _tag: "Failed", message: "The server's answer couldn't be read." }
  }
}

/**
 * Sends one file; a chat in parts of at most 8 MiB, each ending at a line end, read from
 * the file one at a time so a large chat is never held whole. `onBytes` reports progress.
 */
export const sendStFile = async (
  importId: string,
  entry: StFolderFile,
  extra: Record<string, string>,
  onBytes: (sent: number) => void
): Promise<UploadOutcome<StFileResult>> => {
  const query = (more: Record<string, string>) =>
    new URLSearchParams({ import: importId, path: entry.path, ...extra, ...more })
  if (entry.kind !== "chat" && entry.kind !== "group_chat") {
    const answer = await post(query({}), entry.file)
    onBytes(entry.file.size)
    return answer
  }
  let start = 0
  let part = 0
  for (;;) {
    let bytes = new Uint8Array(await entry.file.slice(start, start + ST_CHAT_PART_BYTES).arrayBuffer())
    let last = start + bytes.byteLength >= entry.file.size
    if (!last) {
      const end = bytes.lastIndexOf(0x0a)
      if (end < 0)
        return { _tag: "Failed", message: "A message in this chat is larger than 8 MB, which the import can't take." }
      bytes = bytes.subarray(0, end + 1)
      last = start + bytes.byteLength >= entry.file.size
    }
    const answer = await post(query({ part: String(part), last: last ? "1" : "0" }), bytes)
    start += bytes.byteLength
    onBytes(start)
    if (answer._tag !== "Done" || answer.result.outcome !== "continue") return answer
    if (last) return { _tag: "Failed", message: "The server wanted more of a chat that had ended." }
    part++
  }
}
