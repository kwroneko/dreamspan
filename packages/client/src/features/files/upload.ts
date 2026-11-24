// Uploads into Files (spec/FILES-AND-ENVIRONMENT.md §1.1): files and whole folders, from the
// pickers or a drop, keeping subfolders. When a name is taken the user answers once for the
// batch: Keep both, Replace or Skip.
import { joinPath, type UploadConflict, type UploadOutcome } from "@dreamspan/shared/files.ts"
import { NameTaken, NoRoom, type FilesSource } from "./source.ts"

/** One thing to upload: a file at a path relative to the folder it goes into, or an empty folder. */
export type UploadItem =
  | { readonly kind: "file"; readonly relative: string; readonly file: File }
  | { readonly kind: "folder"; readonly relative: string }

/** What the input gave: `webkitRelativePath` keeps a picked folder's own name and subfolders. */
export const itemsFromInput = (files: Iterable<File>): ReadonlyArray<UploadItem> =>
  [...files].map((file) => ({ kind: "file", relative: file.webkitRelativePath || file.name, file }))

const readAll = (reader: FileSystemDirectoryReader) =>
  new Promise<ReadonlyArray<FileSystemEntry>>((resolve, reject) => {
    const all: Array<FileSystemEntry> = []
    // readEntries answers in pieces (100 at a time in Chromium) until an empty one.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all)
        else {
          all.push(...batch)
          next()
        }
      }, reject)
    next()
  })

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject))

const walk = async (entry: FileSystemEntry, prefix: string, out: Array<UploadItem>) => {
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) out.push({ kind: "file", relative, file: await fileOf(entry as FileSystemFileEntry) })
  else if (entry.isDirectory) {
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader())
    if (children.length === 0) out.push({ kind: "folder", relative })
    for (const child of children) await walk(child, relative, out)
  }
}

/**
 * What a drop holds, folders walked through `webkitGetAsEntry`. Read synchronously first: the
 * items are gone once the drop event returns.
 */
export const itemsFromDrop = async (data: DataTransfer): Promise<ReadonlyArray<UploadItem>> => {
  const entries = [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => ({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() }))
  const out: Array<UploadItem> = []
  for (const { entry, file } of entries) {
    if (entry) await walk(entry, "", out)
    else if (file) out.push({ kind: "file", relative: file.name, file })
  }
  return out
}

/** Whether a drag carries files from outside (not text, not the app's own drags). */
export const carriesFiles = (data: DataTransfer | null) => !!data && [...data.types].includes("Files")

export type ConflictAnswer = Exclude<UploadConflict, "ask">

export interface UploadReport {
  readonly written: ReadonlyArray<string>
  readonly skipped: number
  readonly failed: ReadonlyArray<{ readonly relative: string; readonly message: string }>
  /** The top-level names the batch made, for Undo. */
  readonly made: ReadonlyArray<string>
  /** The server refused for lack of room: the batch stopped there, with this much and these many files left. */
  readonly noRoom: { readonly bytes: number; readonly files: number } | null
}

/** The bytes and file count left when an upload is refused for lack of room. */
export const batchSize = (items: ReadonlyArray<UploadItem>) =>
  items.reduce(
    (sum, item) => (item.kind === "file" ? { bytes: sum.bytes + item.file.size, files: sum.files + 1 } : sum),
    { bytes: 0, files: 0 }
  )

/**
 * Uploads the items into `folder`, one at a time. The first taken name asks `choose` (once for
 * the batch); null from it stops the batch there.
 */
export const uploadAll = async (
  source: Pick<FilesSource, "upload" | "createFolder">,
  folder: string,
  items: ReadonlyArray<UploadItem>,
  choose: () => Promise<ConflictAnswer | null>,
  onProgress?: (done: number, total: number) => void
): Promise<UploadReport> => {
  let answer: ConflictAnswer | null = null
  const written: Array<string> = []
  const made = new Set<string>()
  const failed: Array<{ relative: string; message: string }> = []
  let skipped = 0
  let noRoom: UploadReport["noRoom"] = null
  const total = items.reduce((sum, item) => sum + (item.kind === "file" ? item.file.size : 0), 0)
  let done = 0
  for (const [index, item] of items.entries()) {
    const path = joinPath(folder, item.relative)
    try {
      if (item.kind === "folder") {
        await source.createFolder(path)
        made.add(joinPath(folder, item.relative.split("/")[0]!))
        continue
      }
      const put = (conflict: UploadConflict) =>
        source.upload(path, item.file, conflict, (sent) => onProgress?.(done + sent, total))
      let outcome: UploadOutcome
      try {
        outcome = await put(answer ?? "ask")
      } catch (error) {
        if (!(error instanceof NameTaken)) throw error
        answer ??= await choose()
        if (answer === null) break
        outcome = await put(answer)
      }
      if (outcome.outcome === "skipped") skipped++
      else {
        written.push(outcome.path)
        // A replaced file isn't the batch's to take back by deleting it.
        if (outcome.outcome === "written") made.add(topOf(folder, outcome.path))
      }
    } catch (error) {
      if (error instanceof NoRoom) {
        noRoom = batchSize(items.slice(index))
        break
      }
      failed.push({ relative: item.relative, message: error instanceof Error ? error.message : String(error) })
    }
    if (item.kind === "file") done += item.file.size
    onProgress?.(done, total)
  }
  return { written, skipped, failed, made: [...made], noRoom }
}

/** The batch's top-level path that holds `path`: the file itself, or the dropped folder. */
const topOf = (folder: string, path: string) => {
  const rest = path.slice(folder.length).replace(/^\/+/, "")
  return joinPath(folder, rest.split("/")[0]!)
}
