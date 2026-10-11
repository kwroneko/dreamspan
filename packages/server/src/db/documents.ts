// Library documents as stored: their content hash and their search text. Pure, so the
// format workers work them out for an import, and the writer only stores them (§10.1).
import { createHash } from "node:crypto"
import type { Doc } from "@rp/shared/library.ts"

/** JSON with object keys sorted, so equal documents hash equally whatever their key order. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
        )
      : value

export const docHash = (doc: Doc) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(doc)))
    .digest("hex")

/** Text extracted from a document for full-text search: every string value in it. */
export const searchText = (doc: unknown): string => {
  const parts: Array<string> = []
  const walk = (value: unknown) => {
    if (typeof value === "string") parts.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk)
  }
  walk(doc)
  return parts.join("\n")
}
