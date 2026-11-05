// "Import a new version…" over the import route (ARCHITECTURE.md §11.1, §11.4): `preview`
// parses the file and stores nothing; `replace` makes its content the card's next revision,
// if the card's head is still the one the preview showed; `merge` puts the file on the card's
// import line without changing the card, for the merge review to take its changes from.
import { CardReplacePreview } from "@rp/shared/cardReplace.ts"
import type { RefId, RevisionId } from "@rp/shared/library.ts"
import { ImportResult } from "@rp/shared/libraryImport.ts"
import { Schema } from "effect"
import { failure, type UploadOutcome } from "../library/files.ts"

const send = async <A>(
  file: File,
  query: Record<string, string>,
  decode: (u: unknown) => A,
  what: string
): Promise<UploadOutcome<A>> => {
  let response: Response
  try {
    response = await fetch(`/library/import?${new URLSearchParams({ name: file.name, ...query })}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file
    })
  } catch {
    return { _tag: "Failed", message: "The file didn't reach the server. Check that it's running." }
  }
  if (response.status === 401) return { _tag: "Unauthorized" }
  if (!response.ok) return { _tag: "Failed", message: await failure(response, what) }
  try {
    return { _tag: "Done", result: decode(await response.json()) }
  } catch {
    return { _tag: "Failed", message: "The server's answer couldn't be read." }
  }
}

export const previewVersion = (file: File, refId: RefId) =>
  send(file, { into: refId, mode: "preview" }, Schema.decodeUnknownSync(CardReplacePreview), "read the file")

export const replaceWithVersion = (file: File, refId: RefId, head: RevisionId) =>
  send(file, { into: refId, mode: "replace", head }, Schema.decodeUnknownSync(ImportResult), "replace the card")

export const stageVersion = (file: File, refId: RefId) =>
  send(file, { into: refId, mode: "merge" }, Schema.decodeUnknownSync(ImportResult), "read the file")
