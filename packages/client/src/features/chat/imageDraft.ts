// Blobs stay in IndexedDB until uploaded; references stay until Send is acknowledged.
// Separate rows keep another tab's attachments from being overwritten by this tab.
export interface ImageDraftEntry {
  readonly id: string
  readonly scope: string
  readonly name: string
  readonly position?: number
  readonly pendingPosition?: number
  readonly file?: Blob
  readonly mediaId?: string
  /** A workshop's attachment that isn't an image (spec/FILES-AND-ENVIRONMENT.md §6.1). */
  readonly kind?: "file"
  /** Where it is in Files: saved there by its upload, or attached from there. */
  readonly path?: string
  /** A character card file (spec/WORKSHOP-CARDS.md §4.5), as the server read it. */
  readonly card?: { readonly name: string; readonly format: "png" | "json" | "charx" }
  readonly saved?: boolean
  readonly sending?: {
    readonly draftId: string
    readonly session: number
  }
}
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("dreamspan.message-images", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("images", { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
const transaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("images", mode)
      const request = run(tx.objectStore("images"))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error("Image draft could not be saved."))
    })
  } finally {
    db.close()
  }
}
export const readImages = async (scope: string): Promise<ImageDraftEntry[]> =>
  ((await transaction("readonly", (store) => store.getAll())) as ImageDraftEntry[])
    .filter((entry) => entry.scope === scope)
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
        (a.pendingPosition ?? 0) - (b.pendingPosition ?? 0)
    )
export const keepImage = (entry: ImageDraftEntry) => transaction("readwrite", (store) => store.put(entry))
export const dropImage = (id: string) => transaction("readwrite", (store) => store.delete(id))
/** Moves what `from` holds to `to`, each kept as it is (its upload still to replay, if it was). */
export const adoptImages = async (from: string, to: string) => {
  for (const entry of await readImages(from)) await keepImage({ ...entry, scope: to })
}
/**
 * A group's old new-chat page kept its attachments under `<prefix>pending-group-chat:<sorted
 * character ids>:<group name>`: one whose characters are all in `cast` is that group's.
 */
export const isGroupCopyOf = (prefix: string, scope: string, cast: ReadonlySet<string>) => {
  const head = `${prefix}pending-group-chat:`
  if (!scope.startsWith(head)) return false
  const ids = scope.slice(head.length).split(":")[0]!.split(",").filter(Boolean)
  return ids.length > 0 && ids.every((id) => cast.has(id))
}
/** Moves what every scope `from` picks holds to `to`, as `adoptImages` does. */
export const adoptImagesWhere = async (from: (scope: string) => boolean, to: string) => {
  const all = (await transaction("readonly", (store) => store.getAll())) as ImageDraftEntry[]
  for (const entry of all) if (entry.scope !== to && from(entry.scope)) await keepImage({ ...entry, scope: to })
}
