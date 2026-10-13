// Importing an ST data folder (ARCHITECTURE.md §13): which of its files go, in what order,
// and each one, a chat in parts cut at line ends. A folder named by its path is read where
// the app runs; one picked in the browser is sent over HTTP.
import {
  classifyStPath,
  findStRoots,
  orderStChats,
  ST_CHAT_PART_BYTES,
  ST_FILE_ORDER,
  type StFile,
  type StRoot
} from "@rp/shared/stFolder.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { StFileResult, type StFolderEntry } from "@rp/shared/stImportApi.ts"
import { Schema } from "effect"
import { failure, type UploadOutcome } from "./files.ts"

/** Where a file's bytes come from: the folder at a path, or a file picked in the browser. */
export type StSource =
  | { readonly _tag: "Path"; readonly root: string; readonly modifiedMs: number; readonly mainChat: string | null }
  | { readonly _tag: "Picked"; readonly file: File }

/** A file of the chosen folder, by its path in it. */
export interface StFound {
  readonly path: string
  readonly size: number
  readonly source: StSource
}

export interface StFolderFile extends StFound {
  readonly kind: StFile["kind"]
}

export const pickedFiles = (files: ReadonlyArray<File>): ReadonlyArray<StFound> =>
  files.map((file) => ({
    path: file.webkitRelativePath || file.name,
    size: file.size,
    source: { _tag: "Picked", file }
  }))

export const pathFiles = (root: string, files: ReadonlyArray<StFolderEntry>): ReadonlyArray<StFound> =>
  files.map(({ path, size, modifiedMs, mainChat }) => ({
    path,
    size,
    source: { _tag: "Path", root, modifiedMs, mainChat }
  }))

export const stRoots = (found: ReadonlyArray<StFound>): ReadonlyArray<StRoot> =>
  findStRoots(found.map((entry) => entry.path))

/** The files of one user's folder the import reads, in the order they go, and those it lists unread. */
export const stPlan = (found: ReadonlyArray<StFound>, prefix: string) => {
  const send: Array<StFolderFile> = []
  const unsupported: Array<string> = []
  for (const { path, size, source } of found) {
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    const kind = classifyStPath(relative)?.kind
    if (kind === "unsupported") unsupported.push(relative)
    else if (kind !== undefined)
      send.push({
        path: relative,
        size,
        kind,
        // Read from the ST user's folder, where `relative` is.
        source:
          source._tag === "Path"
            ? { ...source, root: prefix === "" ? source.root : `${source.root}/${prefix.slice(0, -1)}` }
            : source
      })
  }
  send.sort((a, b) => ST_FILE_ORDER.indexOf(a.kind) - ST_FILE_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path))
  return { send, unsupported }
}

const isChat = (entry: StFolderFile) => entry.kind === "chat" || entry.kind === "group_chat"

/** The chat a branch file names as its parent (`main_chat`), from its first line. */
const mainChatOf = async (source: StSource) => {
  if (source._tag === "Path") return source.mainChat
  const head = await source.file.slice(0, 64 * 1024).text()
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
  for (const entry of send) if (isChat(entry)) chats.push({ ...entry, mainChat: await mainChatOf(entry.source) })
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

/** One file read where the app runs, or the part of a chat from byte `start` (ImportStFolderFile). */
export type ReadPart = (request: {
  readonly importId: string
  readonly root: string
  readonly path: string
  readonly size: number
  readonly modifiedMs: number
  readonly start: number
  readonly part: number
  readonly card: EntityId | "none" | null
  readonly orphan: boolean
}) => Promise<UploadOutcome<{ readonly result: StFileResult; readonly next: number; readonly last: boolean }>>

/** What a choice of card, or a branch sent on its own, adds to a file's request. */
export interface StExtra {
  readonly card?: EntityId | "none"
  readonly orphan?: boolean
}

/**
 * Imports one file; a chat in parts of at most 8 MiB, each ending at a line end, read one
 * at a time so a large chat is never held whole. `onBytes` reports progress.
 */
export const sendStFile = async (
  importId: string,
  entry: StFolderFile,
  extra: StExtra,
  onBytes: (sent: number) => void,
  readPart: ReadPart
): Promise<UploadOutcome<StFileResult>> => {
  const { source } = entry
  if (source._tag === "Path") {
    let start = 0
    for (let part = 0; ; part++) {
      const answer = await readPart({
        importId,
        root: source.root,
        path: entry.path,
        size: entry.size,
        modifiedMs: source.modifiedMs,
        start,
        part,
        card: extra.card ?? null,
        orphan: extra.orphan ?? false
      })
      if (answer._tag !== "Done") return answer
      start = answer.result.next
      onBytes(start)
      const { result, last } = answer.result
      if (result.outcome !== "continue") return { _tag: "Done", result }
      if (last) return { _tag: "Failed", message: "The import wanted more of a chat that had ended." }
    }
  }
  const query = (more: Record<string, string>) =>
    new URLSearchParams({
      import: importId,
      path: entry.path,
      ...(extra.card === undefined ? {} : { card: extra.card }),
      ...(extra.orphan ? { orphan: "1" } : {}),
      ...more
    })
  const file = source.file
  if (entry.kind !== "chat" && entry.kind !== "group_chat") {
    const answer = await post(query({}), file)
    onBytes(file.size)
    return answer
  }
  let start = 0
  let part = 0
  for (;;) {
    let bytes = new Uint8Array(await file.slice(start, start + ST_CHAT_PART_BYTES).arrayBuffer())
    let last = start + bytes.byteLength >= file.size
    if (!last) {
      const end = bytes.lastIndexOf(0x0a)
      if (end < 0)
        return { _tag: "Failed", message: "A message in this chat is larger than 8 MB, which the import can't take." }
      bytes = bytes.subarray(0, end + 1)
      last = start + bytes.byteLength >= file.size
    }
    const answer = await post(query({ part: String(part), last: last ? "1" : "0" }), bytes)
    start += bytes.byteLength
    onBytes(start)
    if (answer._tag !== "Done" || answer.result.outcome !== "continue") return answer
    if (last) return { _tag: "Failed", message: "The server wanted more of a chat that had ended." }
    part++
  }
}
