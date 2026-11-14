// Sending an ST data folder picked in the browser (ARCHITECTURE.md §13): which of its files
// go, in what order (the plan the server uses for a folder it reads, `@rp/shared/stPlan.ts`),
// and each one over HTTP, a chat in parts cut at line ends; and the chat files a re-import
// preview asks for (`POST /st-import/plan-file`), the same way. A folder named by its path is
// imported on the server instead (StartStPathImport): nothing of it passes through here.
import { findStRoots, ST_CHAT_PART_BYTES, type StRoot } from "@rp/shared/stFolder.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import { StFileResult } from "@rp/shared/stImportApi.ts"
import { orderStBranches, ST_HEAD_BYTES, stMainChat, type StPlanned, stPlan } from "@rp/shared/stPlan.ts"
import { Schema } from "effect"
import { failure } from "./files.ts"

/** A file of the picked folder, by its path in it. */
export interface StFound {
  readonly path: string
  readonly size: number
  readonly file: File
}

export type StFolderFile = StPlanned<StFound>

export const pickedFiles = (files: ReadonlyArray<File>): ReadonlyArray<StFound> =>
  files.map((file) => ({ path: file.webkitRelativePath || file.name, size: file.size, file }))

export const stRoots = (paths: ReadonlyArray<string>): ReadonlyArray<StRoot> => findStRoots(paths)

/** The folder the browser picked, by its name, for the job's row. */
export const pickedName = (found: ReadonlyArray<StFound>, prefix: string) =>
  prefix === "" ? (found[0]?.path.split("/")[0] ?? "") : prefix.slice(0, -1)

/** The files of one user's folder the import reads, in the order they go, parents before branches. */
export const orderedPlan = async (found: ReadonlyArray<StFound>, prefix: string) => {
  const { send, unsupported } = stPlan(found, prefix)
  const mainChats = new Map<string, string | null>()
  for (const entry of send) {
    if (entry.kind === "chat" || entry.kind === "group_chat")
      mainChats.set(entry.path, stMainChat(await entry.item.file.slice(0, ST_HEAD_BYTES).text()))
  }
  return { send: orderStBranches(send, (entry) => mainChats.get(entry.path) ?? null), unsupported, mainChats }
}

/** The server's answer to one file: `Gone` when the import is over (cancelled, or another started). */
export type StSent = Answer<StFileResult>

const decode = Schema.decodeUnknownSync(StFileResult)

/** The preview's answer to a part: `restart` when it lost the chat's earlier parts. */
const PlanFileResult = Schema.Struct({ outcome: Schema.Literals(["continue", "done", "restart"]) })
const decodePlan = Schema.decodeUnknownSync(PlanFileResult)

type Answer<A> =
  | { readonly _tag: "Done"; readonly result: A }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "Gone" }

const post = async <A>(
  url: string,
  query: URLSearchParams,
  body: Blob | Uint8Array<ArrayBuffer>,
  read: (json: unknown) => A
): Promise<Answer<A>> => {
  let response: Response
  try {
    response = await fetch(`${url}?${query}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body
    })
  } catch {
    return { _tag: "Failed", message: "The upload didn't reach the server. Check that it's running." }
  }
  if (response.status === 401) return { _tag: "Unauthorized" }
  if (response.status === 404) return { _tag: "Gone" }
  if (!response.ok) return { _tag: "Failed", message: await failure(response, "import the file") }
  try {
    return { _tag: "Done", result: read(await response.json()) }
  } catch {
    return { _tag: "Failed", message: "The server's answer couldn't be read." }
  }
}

/** What a choice of card, or a branch sent on its own, adds to a file's request. */
export interface StExtra {
  readonly card?: EntityId | "none"
  readonly orphan?: boolean
}

/**
 * Sends one file; a chat in parts of at most 8 MiB, each ending at a line end, read one at
 * a time so a large chat is never held whole. `onBytes` reports progress.
 */
export const sendStFile = async (
  importId: string,
  entry: StFolderFile,
  extra: StExtra,
  onBytes: (sent: number) => void
): Promise<StSent> => {
  const query = (more: Record<string, string>) =>
    new URLSearchParams({
      import: importId,
      path: entry.path,
      modifiedAt: String(entry.item.file.lastModified),
      ...(extra.card === undefined ? {} : { card: extra.card }),
      ...(extra.orphan ? { orphan: "1" } : {}),
      ...more
    })
  const file = entry.item.file
  if (entry.kind !== "chat" && entry.kind !== "group_chat") {
    const answer = await post("/st-import/file", query({}), file, decode)
    onBytes(file.size)
    return answer
  }
  return sendParts("/st-import/file", query, file, decode, (result) => result.outcome === "continue", onBytes)
}

/** One chat file a re-import preview asked for, in parts as an import sends it. */
export const sendStPlanFile = (planId: string, entry: StFolderFile, onBytes: (sent: number) => void) =>
  sendParts(
    "/st-import/plan-file",
    (more) => new URLSearchParams({ plan: planId, path: entry.path, ...more }),
    entry.item.file,
    decodePlan,
    (result) => result.outcome === "continue",
    onBytes
  )

const sendParts = async <A>(
  url: string,
  query: (more: Record<string, string>) => URLSearchParams,
  file: File,
  read: (json: unknown) => A,
  more: (result: A) => boolean,
  onBytes: (sent: number) => void
): Promise<Answer<A>> => {
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
    const answer = await post(url, query({ part: String(part), last: last ? "1" : "0" }), bytes, read)
    start += bytes.byteLength
    onBytes(start)
    if (answer._tag !== "Done" || !more(answer.result)) return answer
    if (last) return { _tag: "Failed", message: "The server wanted more of a chat that had ended." }
    part++
  }
}
