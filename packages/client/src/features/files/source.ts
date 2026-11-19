// Where the file manager reads and changes files (spec/FILES-AND-ENVIRONMENT.md §1, §8.1): a
// registered, replaceable part (owner rule: every feature a registered part), so a plugin can put
// another store behind the same panel. The built-in source speaks the HTTP contract in
// `@dreamspan/shared/files.ts`; the first registered source by order is the one used.
import { Changed, Deleted, FILES_ROUTES, FolderListing, UploadOutcome, type UploadConflict } from "@dreamspan/shared/files.ts"
import { Schema } from "effect"
import { useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"

/** A refusal the user can read: the server's own words where it gave some. */
class FilesError extends Error {}

/** The name is taken and the upload asked what to do (`conflict: "ask"`). */
export class NameTaken extends FilesError {}

/** There's no room left for it in the account's Files quota (507). */
export class NoRoom extends FilesError {}

export interface FilesSource {
  readonly id: string
  readonly order: number
  readonly list: (path: string) => Promise<FolderListing>
  readonly upload: (
    path: string,
    file: Blob,
    conflict: UploadConflict,
    onProgress?: (sent: number) => void
  ) => Promise<UploadOutcome>
  readonly createFolder: (path: string) => Promise<Changed>
  readonly move: (from: string, to: string) => Promise<Changed>
  readonly remove: (path: string) => Promise<Deleted>
  readonly restore: (binItemId: string) => Promise<Changed>
  /** The URL a viewer loads the file from, or a download starts at. */
  readonly rawUrl: (path: string, download?: boolean) => string
}

export const filesSources = makeRegistry<FilesSource>()

const pick = (snapshot = filesSources.snapshot()) => [...snapshot.entries].sort((a, b) => a.order - b.order)[0] ?? null

export const useFilesSource = () => {
  const snapshot = useSyncExternalStore(filesSources.subscribe, filesSources.snapshot, filesSources.snapshot)
  return pick(snapshot)
}

const failure = async (response: Response) => {
  const text = await response.text().catch(() => "")
  let message = text.trim()
  try {
    const body = JSON.parse(text) as { message?: unknown; taken?: unknown }
    if (body.taken === true) return new NameTaken("That name is taken.")
    if (typeof body.message === "string") message = body.message
  } catch {
    // Plain text, or nothing.
  }
  if (response.status === 507) return new NoRoom(message || "There's no room left for files.")
  if (response.status === 404 && message === "") message = "Not found. It may have been moved or deleted."
  return new FilesError(message || `The server answered ${response.status}.`)
}

const reach = async (input: string, init?: RequestInit) => {
  try {
    return await fetch(input, init)
  } catch {
    throw new FilesError("The server can't be reached.")
  }
}

const json = async <S extends Schema.Top>(schema: S, response: Response): Promise<S["Type"]> => {
  if (!response.ok) throw await failure(response)
  try {
    return Schema.decodeUnknownSync(schema as never)(await response.json()) as S["Type"]
  } catch {
    throw new FilesError("The server's answer wasn't understood.")
  }
}

const post = (route: string, body: unknown) =>
  reach(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** Streams the bytes with progress (fetch can't report an upload's progress). */
const send = (url: string, file: Blob, onProgress?: (sent: number) => void) =>
  new Promise<Response>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("POST", url)
    request.setRequestHeader("content-type", "application/octet-stream")
    if (onProgress) request.upload.onprogress = (event) => onProgress(event.loaded)
    request.onerror = () => reject(new FilesError("The server can't be reached."))
    request.onload = () =>
      resolve(new Response(request.responseText, { status: request.status, statusText: request.statusText }))
    request.send(file)
  })

export const httpFilesSource: FilesSource = {
  id: "files.http",
  order: 100,
  list: async (path) =>
    json(FolderListing, await reach(`${FILES_ROUTES.list}?${new URLSearchParams({ path })}`, { cache: "no-store" })),
  upload: async (path, file, conflict, onProgress) =>
    json(
      UploadOutcome,
      await send(`${FILES_ROUTES.upload}?${new URLSearchParams({ path, conflict })}`, file, onProgress)
    ),
  createFolder: async (path) => json(Changed, await post(FILES_ROUTES.folder, { path })),
  move: async (from, to) => json(Changed, await post(FILES_ROUTES.move, { from, to })),
  remove: async (path) => json(Deleted, await post(FILES_ROUTES.delete, { path })),
  restore: async (binItemId) => json(Changed, await post(FILES_ROUTES.restore, { binItemId })),
  rawUrl: (path, download = false) =>
    `${FILES_ROUTES.raw}?${new URLSearchParams(download ? { path, download: "1" } : { path })}`
}
