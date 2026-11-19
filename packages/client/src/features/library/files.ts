// Files to and from the library: plain HTTP, since RPC messages are JSON (ARCHITECTURE.md
// §11.4). The session cookie goes with each request, as with the WebSocket.
import type { RefId } from "@dreamspan/shared/library.ts"
import { type ExportFormat, ImportResult } from "@dreamspan/shared/libraryImport.ts"
import { Schema } from "effect"

export type UploadOutcome<A = ImportResult> =
  | { readonly _tag: "Done"; readonly result: A }
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "Failed"; readonly message: string }

const decodeResult = Schema.decodeUnknownSync(ImportResult)

/** The server's `{error}` sentence, or a fallback with the status. */
export const failure = async (response: Response, what: string) => {
  const body: unknown = await response.json().catch(() => null)
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : null
  return typeof error === "string" && error !== ""
    ? `${error[0]!.toUpperCase()}${error.slice(1)}${/[.!?]$/.test(error) ? "" : "."}`
    : `The server couldn't ${what} (${response.status}).`
}

export const uploadFile = async (file: File, into: RefId | null): Promise<UploadOutcome> => {
  const query = new URLSearchParams({ name: file.name, ...(into ? { into } : {}) })
  let response: Response
  try {
    response = await fetch(`/library/import?${query}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file
    })
  } catch {
    return { _tag: "Failed", message: "The upload didn't reach the server. Check that it's running." }
  }
  if (response.status === 401) return { _tag: "Unauthorized" }
  if (!response.ok) return { _tag: "Failed", message: await failure(response, "import the file") }
  try {
    return { _tag: "Done", result: decodeResult(await response.json()) }
  } catch {
    return { _tag: "Failed", message: "The server's answer couldn't be read." }
  }
}

/** The name in `Content-Disposition`, the UTF-8 one when given. */
const fileName = (disposition: string | null, fallback: string) => {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      // Fall through to the plain name.
    }
  }
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? fallback
}

export interface ChatExportRequest {
  readonly chatId: string
  readonly forkId: string | null
  readonly scope: "branch" | "all"
  readonly format: "jsonl" | "txt"
}

/**
 * Downloads a chat export (ARCHITECTURE.md §13b), which the server writes as it reads the
 * chat; `onProgress` gets the bytes received so far. Resolves to an error sentence, null
 * once the download started, or "aborted" when `signal` stopped it.
 */
export const downloadChatExport = (
  request: ChatExportRequest,
  onProgress: (bytes: number) => void,
  signal: AbortSignal
) => streamedDownload("/library/chat-export", request, "export the chat", onProgress, signal)

/** The whole library as one .zip (ARCHITECTURE.md §13b), as `downloadChatExport`. */
export const downloadLibraryArchive = (onProgress: (bytes: number) => void, signal: AbortSignal) =>
  streamedDownload("/library/archive", {}, "export the library", onProgress, signal)

const streamedDownload = async (
  path: string,
  request: unknown,
  what: string,
  onProgress: (bytes: number) => void,
  signal: AbortSignal
): Promise<string | null | "aborted"> => {
  let key: string | undefined
  const stop = () => {
    if (key)
      void fetch(`/library/download-stop?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        keepalive: true
      }).catch(() => {})
  }
  try {
    // Do not abort preparation: if it finishes after Stop, release its reservation below.
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-export-download": "native" },
      body: JSON.stringify(request)
    })
    if (!response.ok) return failure(response, what)
    const prepared = (await response.json()) as { key: string }
    key = prepared.key
    signal.addEventListener("abort", stop, { once: true })
    if (signal.aborted) {
      stop()
      return "aborted"
    }
    const link = document.createElement("a")
    link.href = `/library/download?key=${encodeURIComponent(key)}`
    link.download = ""
    link.click()
    for (;;) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
      if (signal.aborted) return "aborted"
      const status = await fetch(`/library/download-status?key=${encodeURIComponent(key)}`, { signal })
      if (!status.ok) {
        stop()
        return failure(status, what)
      }
      const progress = (await status.json()) as { bytes: number; done: boolean; error: string | null }
      onProgress(progress.bytes)
      if (progress.done) return progress.error
    }
  } catch {
    stop()
    if (signal.aborted) return "aborted"
    return "The export stopped before it was done. Check that the server is running, and try again."
  } finally {
    signal.removeEventListener("abort", stop)
  }
}

/** Downloads a ref as a file. Resolves to an error sentence, or null once the download started. */
export const downloadExport = async (refId: RefId, format: ExportFormat, label: string): Promise<string | null> => {
  let response: Response
  try {
    response = await fetch("/library/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refId, format })
    })
  } catch {
    return "Can't reach the server. Check that it's running."
  }
  if (!response.ok) return failure(response, "export it")
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement("a")
  link.href = url
  link.download = fileName(response.headers.get("content-disposition"), label)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return null
}
