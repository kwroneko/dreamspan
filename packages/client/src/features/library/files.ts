// Files to and from the library: plain HTTP, since RPC messages are JSON (ARCHITECTURE.md
// §11.4). The session cookie goes with each request, as with the WebSocket.
import type { RefId } from "@rp/shared/library.ts"
import { type ExportFormat, ImportResult } from "@rp/shared/libraryImport.ts"
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

/** Hands bytes to the browser as a download named `name`. */
const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
  fallbackName: string,
  onProgress: (bytes: number) => void,
  signal: AbortSignal
) => streamedDownload("/library/chat-export", request, "export the chat", fallbackName, onProgress, signal)

/** The whole library as one .zip (ARCHITECTURE.md §13b), as `downloadChatExport`. */
export const downloadLibraryArchive = (onProgress: (bytes: number) => void, signal: AbortSignal) =>
  streamedDownload("/library/archive", {}, "export the library", "Library.zip", onProgress, signal)

const streamedDownload = async (
  path: string,
  request: unknown,
  what: string,
  fallbackName: string,
  onProgress: (bytes: number) => void,
  signal: AbortSignal
): Promise<string | null | "aborted"> => {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal
    })
    if (!response.ok) return failure(response, what)
    const parts: Array<Uint8Array<ArrayBuffer>> = []
    let received = 0
    const reader = response.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      received += value.byteLength
      onProgress(received)
    }
    save(
      new Blob(parts, { type: response.headers.get("content-type") ?? "application/octet-stream" }),
      fileName(response.headers.get("content-disposition"), fallbackName)
    )
    return null
  } catch {
    if (signal.aborted) return "aborted"
    return "The export stopped before it was done. Check that the server is running, and try again."
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
