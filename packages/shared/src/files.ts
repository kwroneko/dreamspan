// The account's Files as the client sees them (spec/FILES-AND-ENVIRONMENT.md §1, §8.1): paths are
// the sandbox's own (`/files/thesis/report.pdf`), so a path copied from the Files panel works in
// the agent's tools and commands, and the other way round. This module holds the HTTP contract
// the file manager calls (§1.1 names `POST /files/upload` and `GET /files/raw`; the listing and
// the changes are named here, for the server's handlers to match) and the pure path rules both
// sides share.
import { Schema } from "effect"

/** The top of the account's Files, as commands and the file tools see it. */
export const FILES_TOP = "/files"

/** The HTTP routes of the file manager. All take and return JSON except upload (the bytes) and raw. */
export const FILES_ROUTES = {
  /** GET `?path=`: a folder's entries (`FolderListing`). */
  list: "/files/list",
  /** POST `?path=&conflict=`, the file's bytes as the body (`UploadOutcome`). Missing folders are made. */
  upload: "/files/upload",
  /** GET `?path=` (and `&download=1` for an attachment): a regular file's bytes, Range requests allowed. */
  raw: "/files/raw",
  /** POST `{ path }`: a new, empty folder (`Changed`). */
  folder: "/files/folder",
  /** POST `{ from, to }`: a rename or move (`Changed`). */
  move: "/files/move",
  /** POST `{ path }`: to the bin when the listing said so, otherwise gone (`Deleted`). */
  delete: "/files/delete",
  /** POST `{ binItemId }`: a deleted file or folder put back (`Changed`). */
  restore: "/files/restore",
  /** GET `?path=`: a folder and everything in it as one zip, streamed (links and special files left out). */
  zip: "/files/zip"
} as const

/** What a name is: links and special files are listed with their kind and never opened (§1.1). */
const FileKind = Schema.Literals(["file", "folder", "link", "other"])

export const FileEntry = Schema.Struct({
  name: Schema.String,
  kind: FileKind,
  /** Bytes, for a file. */
  size: Schema.Number,
  mtimeMs: Schema.Number
})
export type FileEntry = typeof FileEntry.Type

export const FolderListing = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(FileEntry),
  /** More entries than the server lists at once. */
  more: Schema.Boolean,
  /** A folder shared with this account as Can view: every change is refused (§1.4). */
  readOnly: Schema.Boolean,
  /** Deleting here moves to the bin, with Undo (§1.3); false: it's gone, so the app asks first. */
  bin: Schema.Boolean
})
export type FolderListing = typeof FolderListing.Type

/** When an upload's name is taken: ask (409 with `{ taken: true }`), or one of the batch-wide answers (§1.1). */
export const UploadConflict = Schema.Literals(["ask", "keep", "replace", "skip"])
export type UploadConflict = typeof UploadConflict.Type

export const UploadOutcome = Schema.Struct({
  /** Where it was written: another name under Keep both. */
  path: Schema.String,
  outcome: Schema.Literals(["written", "replaced", "skipped"])
})
export type UploadOutcome = typeof UploadOutcome.Type

export const Changed = Schema.Struct({ path: Schema.String })
export type Changed = typeof Changed.Type

export const Deleted = Schema.Struct({ binItemId: Schema.NullOr(Schema.String) })
export type Deleted = typeof Deleted.Type

// --- Paths -------------------------------------------------------------------------------

const segments = (path: string) => path.split("/").filter((part) => part !== "")

/** A path under the top, normalized: one slash between names, none at the end. */
export const normalizePath = (path: string) => {
  const parts = segments(path)
  if (parts[0] !== FILES_TOP.slice(1)) return FILES_TOP
  return `/${parts.join("/")}`
}

export const isTop = (path: string) => normalizePath(path) === FILES_TOP

export const joinPath = (folder: string, name: string) =>
  normalizePath(`${normalizePath(folder)}/${segments(name).join("/")}`)

/** The folder holding it; the top for the top. */
export const parentOf = (path: string) => {
  const parts = segments(normalizePath(path))
  return parts.length <= 1 ? FILES_TOP : `/${parts.slice(0, -1).join("/")}`
}

/** Its last name; "Files" for the top. */
export const nameOf = (path: string) => (isTop(path) ? "Files" : segments(normalizePath(path)).at(-1)!)

/** Each folder from the top down to it, for a breadcrumb. */
export const crumbsOf = (path: string): ReadonlyArray<{ readonly name: string; readonly path: string }> => {
  const parts = segments(normalizePath(path))
  return parts.map((_, i) => {
    const at = `/${parts.slice(0, i + 1).join("/")}`
    return { name: nameOf(at), path: at }
  })
}

/** The folders whose listings show `path` or a folder on its way: its parent up to the top. */
export const foldersShowing = (path: string): ReadonlyArray<string> => {
  const crumbs = crumbsOf(parentOf(path)).map((crumb) => crumb.path)
  return isTop(path) ? [] : crumbs
}

/** Whether `path` is `folder` or inside it. */
export const isWithin = (path: string, folder: string) => {
  const p = normalizePath(path)
  const f = normalizePath(folder)
  return p === f || p.startsWith(`${f}/`)
}

/** Why a name can't be used, or null. The same limits as the server's walk (§1.1). */
export const nameProblem = (name: string): string | null => {
  if (name.trim() === "") return "A name can't be empty."
  if (name === "." || name === "..") return "A name can't be “.” or “..”."
  if (name.includes("/")) return "A name can't contain “/”."
  if (name.includes("\0")) return "A name can't contain a NUL character."
  if (new TextEncoder().encode(name).length > 255) return "That name is too long."
  return null
}

/** "report (2).pdf" for a taken "report.pdf": the first free number, as Keep both names it (§1.1). */
export const keepBothName = (name: string, taken: ReadonlySet<string>) => {
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

// --- Listing order -----------------------------------------------------------------------

export type FileSort = "name" | "size" | "date"

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Folders first, then by the chosen key; names break ties (§8.1). Size and date go largest and newest first. */
export const sortEntries = (entries: ReadonlyArray<FileEntry>, by: FileSort): ReadonlyArray<FileEntry> =>
  [...entries].sort((a, b) => {
    const folders = Number(b.kind === "folder") - Number(a.kind === "folder")
    if (folders !== 0) return folders
    const key = by === "size" ? b.size - a.size : by === "date" ? b.mtimeMs - a.mtimeMs : 0
    return key !== 0 ? key : collator.compare(a.name, b.name)
  })

// --- Which viewer --------------------------------------------------------------------------

export type FileView = "text" | "image" | "video" | "audio" | "pdf" | "download"

const VIEWS: ReadonlyArray<readonly [FileView, ReadonlyArray<string>]> = [
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]],
  ["video", ["mp4", "webm", "mov", "m4v", "ogv"]],
  ["audio", ["mp3", "wav", "ogg", "oga", "m4a", "flac", "opus"]],
  ["pdf", ["pdf"]],
  [
    "text",
    [
      "txt",
      "md",
      "markdown",
      "json",
      "jsonl",
      "yaml",
      "yml",
      "toml",
      "ini",
      "csv",
      "tsv",
      "log",
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "css",
      "scss",
      "html",
      "htm",
      "xml",
      "svg",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "kt",
      "c",
      "h",
      "cpp",
      "hpp",
      "cs",
      "sh",
      "bash",
      "zsh",
      "sql",
      "lua",
      "php",
      "pl",
      "r",
      "swift",
      "env",
      "gitignore",
      "dockerfile",
      "makefile",
      "lock"
    ]
  ]
]

/** The viewer a file opens in, by its name: what isn't known downloads (§8.2). */
export const viewOf = (name: string): FileView => {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf(".")
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower
  for (const [view, extensions] of VIEWS) if (extensions.includes(ext)) return view
  return "download"
}
