// Uploads an ST folder the way the client does (features/library/stImport.ts): picks the
// user folder, starts an import, sends the files in order with chats in parts cut at line
// ends, and sends deferred branches again at the end.
import { classifyStPath, findStRoots, orderStChats, ST_FILE_ORDER } from "@rp/shared/stFolder.ts"
import { StFileResult } from "@rp/shared/stImportApi.ts"
import { Effect, Schema } from "effect"
import { client, serverPort } from "./config.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** Waits for an import job to end, and returns it with its report. */
export const jobEnded = (api: Api, importId: string, ms = 120_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    for (;;) {
      const detail = yield* api.GetStImport({ importId })
      if (detail.job.status !== "running") return detail
      if (Date.now() > deadline) return yield* Effect.die(new Error(`import ${importId} still running`))
      yield* Effect.sleep(20)
    }
  })

/** Imports the folder at `path` on the server (StartStPathImport), its ST user `prefix`, to the end. */
export const importStPath = (api: Api, path: string, prefix = "") =>
  Effect.gen(function* () {
    const { importId } = yield* api.StartStPathImport({ path, prefix })
    return yield* jobEnded(api, importId)
  })

/** Cuts a chat file into parts of at most `max` bytes at line ends. */
const chatParts = (bytes: Uint8Array, max: number) => {
  const parts: Array<Uint8Array> = []
  let start = 0
  while (start < bytes.byteLength) {
    let end = Math.min(start + max, bytes.byteLength)
    if (end < bytes.byteLength) {
      const newline = bytes.lastIndexOf(0x0a, end - 1)
      if (newline < start) throw new Error("a line is longer than a part")
      end = newline + 1
    }
    parts.push(bytes.subarray(start, end))
    start = end
  }
  return parts.length === 0 ? [new Uint8Array()] : parts
}

export const sendFile = (
  importId: string,
  path: string,
  bytes: Uint8Array,
  query: Record<string, string> = {},
  headers: Record<string, string> = {}
) =>
  Effect.flatMap(serverPort, (port) =>
    Effect.promise(() =>
      fetch(`http://127.0.0.1:${port}/st-import/file?${new URLSearchParams({ import: importId, path, ...query })}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...headers },
        body: bytes
      })
    )
  )

const decode = Schema.decodeUnknownSync(StFileResult)

/** Sends one file, a chat in parts; the last part's answer. */
export const sendStFile = (
  importId: string,
  path: string,
  bytes: Uint8Array,
  query: Record<string, string> = {},
  partBytes = 8 * 1024 * 1024
) =>
  Effect.gen(function* () {
    const file = classifyStPath(path)
    const parts = file?.kind === "chat" || file?.kind === "group_chat" ? chatParts(bytes, partBytes) : [bytes]
    let answer = new StFileResult({ outcome: "failed", message: "" })
    for (const [part, body] of parts.entries()) {
      const response = yield* sendFile(importId, path, body, {
        part: String(part),
        last: part === parts.length - 1 ? "1" : "0",
        ...query
      })
      if (response.status !== 200)
        throw new Error(`${path}: ${response.status} ${yield* Effect.promise(() => response.text())}`)
      answer = decode(yield* Effect.promise(() => response.json()))
      if (answer.outcome !== "continue") break
    }
    return answer
  })

/** Imports the folder's user `prefix` (one of `findStRoots`), returning each file's answer. */
export const importStFolder = (
  files: ReadonlyMap<string, Uint8Array>,
  options: { prefix?: string; partBytes?: number; modifiedAt?: ReadonlyMap<string, number> } = {}
) =>
  Effect.gen(function* () {
    const roots = findStRoots([...files.keys()])
    const prefix = options.prefix ?? roots[0]!.prefix
    const mine = [...files].flatMap(([path, bytes]) => {
      if (!path.startsWith(prefix)) return []
      const relative = path.slice(prefix.length)
      const file = classifyStPath(relative)
      return file === null ? [] : [{ path: relative, file, bytes }]
    })
    const api = yield* client()
    const { importId } = yield* api.StartStImport({
      unsupported: mine.filter((f) => f.file.kind === "unsupported").map((f) => f.path)
    })
    const ordered = mine
      .filter((f) => f.file.kind !== "unsupported")
      .sort(
        (a, b) =>
          ST_FILE_ORDER.indexOf(a.file.kind) - ST_FILE_ORDER.indexOf(b.file.kind) || a.path.localeCompare(b.path)
      )
    // Parents before their branches, as the client sends them.
    const mainChat = (bytes: Uint8Array) => {
      try {
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, 64 * 1024)).split("\n", 1)[0]!)
        return typeof header?.chat_metadata?.main_chat === "string" ? (header.chat_metadata.main_chat as string) : null
      } catch {
        return null
      }
    }
    const chats = orderStChats(
      ordered
        .filter((f) => f.file.kind === "chat" || f.file.kind === "group_chat")
        .map((f) => ({ ...f, mainChat: mainChat(f.bytes) }))
    )
    let nextChat = 0
    ordered.splice(
      0,
      ordered.length,
      ...ordered.map((f) => (f.file.kind === "chat" || f.file.kind === "group_chat" ? chats[nextChat++]! : f))
    )
    const times = (path: string) => {
      const at = options.modifiedAt?.get(prefix + path)
      return at === undefined ? {} : { modifiedAt: String(at) }
    }
    const answers = new Map<string, StFileResult>()
    const deferred: typeof ordered = []
    for (const file of ordered) {
      const answer = yield* sendStFile(importId, file.path, file.bytes, times(file.path), options.partBytes)
      if (answer.outcome === "deferred") deferred.push(file)
      else answers.set(file.path, answer)
    }
    // Sent again until nothing more goes in, then on their own.
    let progress = true
    while (deferred.length > 0 && progress) {
      progress = false
      for (const file of deferred.splice(0)) {
        const answer = yield* sendStFile(importId, file.path, file.bytes, times(file.path), options.partBytes)
        if (answer.outcome === "deferred") deferred.push(file)
        else {
          answers.set(file.path, answer)
          progress = true
        }
      }
    }
    for (const file of deferred) {
      answers.set(
        file.path,
        yield* sendStFile(importId, file.path, file.bytes, { ...times(file.path), orphan: "1" }, options.partBytes)
      )
    }
    return { importId, answers, report: yield* api.GetStImportReport({ importId }), api }
  })
