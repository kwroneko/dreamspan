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
  /** GET `?path=`: who a folder of yours is shared with or offered to (`FolderShare[]`). */
  shares: "/files/shares",
  /**
   * POST `{ path, handle, mode }`: offers a folder of yours to an account by its name
   * (`FolderShare`, `invited`), or changes the mode of one it accepted. The answer is the same
   * whether or not an account has that name.
   */
  share: "/files/share",
  /** POST `{ shareId }`: stops sharing, or takes back an invitation. */
  unshare: "/files/unshare",
  /** POST `{ shareId }`: shares an unavailable share's path again, as the folder there now (`FolderShare`). */
  shareAgain: "/files/share/again",
  /** POST `{ invitationId, accept }`: the invited account accepts a share, or declines it. */
  answerInvitation: "/files/invitation",
  /** GET `?path=`: a file's versions, newest first (`FileVersionEntry[]`). */
  versions: "/files/versions",
  /** POST `{ path, versionId }`: a version's content back at the path; what was there is kept (`RestoredVersion`). */
  restoreVersion: "/files/versions/restore",
  /** POST `{ binItemId }`: a deleted file or folder put back (`Changed`). */
  restore: "/files/restore",
  /** GET `?path=`: a folder and everything in it as one zip, streamed (links and special files left out). */
  zip: "/files/zip",
  /**
   * POST `{ path }`: a file of the account's Files attached to a workshop message (§6.1): its
   * content kept as the copy the message sends (`AttachedFile`).
   */
  attach: "/files/attach",
  /** GET `?id=&name=` (and `&download=1`): an attachment's copy as sent, served as `raw` serves files. */
  attachment: "/files/attachment",
  /**
   * GET `?path=`: a text file for the editor (`TextFile`), with the hash of its bytes, which an
   * editor save names as `base` (§8.2). At most `TEXT_OPEN_MAX_BYTES`; 415 for bytes that aren't UTF-8.
   */
  text: "/files/text"
} as const

/** The largest text file the editor opens whole; a larger one is shown read-only, a page at a time (§8.2). */
export const TEXT_OPEN_MAX_BYTES = 5 * 1024 * 1024

/** The longest text the editor lets you change: what an unsaved edit's draft can hold. */
export const TEXT_EDIT_MAX_CHARS = 1_000_000

/** A text file as the editor opens it: its text, and what a save checks it against. */
export const TextFile = Schema.Struct({
  path: Schema.String,
  /** With its line breaks as `\n` and no byte order mark: `lineEnding` and `bom` say how to write it back. */
  text: Schema.String,
  /** The file's line break, the most used one in a mixed file (`lf` for one with none). */
  lineEnding: Schema.Literals(["lf", "crlf", "cr"]),
  /** It starts with a UTF-8 byte order mark. */
  bom: Schema.Boolean,
  /** SHA-256 of the file's bytes, hex: an editor save sends it back as `base`. */
  sha256: Schema.String,
  size: Schema.Number,
  mtimeMs: Schema.Number
})
export type TextFile = typeof TextFile.Type

export type LineEnding = TextFile["lineEnding"]

const BREAKS: Record<LineEnding, string> = { lf: "\n", crlf: "\r\n", cr: "\r" }

/** A text's most used line break (§8.2); `lf` when it has none, or on a tie with it. */
export const lineEndingOf = (text: string): LineEnding => {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++
        i++
      } else cr++
    } else if (code === 10) lf++
  }
  if (crlf > lf && crlf >= cr) return "crlf"
  if (cr > lf && cr > crlf) return "cr"
  return "lf"
}

/** Every line break as `\n`, as the editor holds text. */
export const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, "\n")

/**
 * The editor's text as the file's bytes (§8.2): each line break written as the file had it, and
 * its byte order mark kept, so a one-character edit changes one character.
 */
export const encodeText = (text: string, lineEnding: LineEnding, bom: boolean): Uint8Array => {
  const body = new TextEncoder().encode(normalizeLineEndings(text).replace(/\n/g, BREAKS[lineEnding]))
  if (!bom) return body
  const out = new Uint8Array(body.byteLength + 3)
  out.set([0xef, 0xbb, 0xbf])
  out.set(body, 3)
  return out
}

/** The largest file a message can attach; larger ones stay in Files for the assistant to open (§6.1). */
export const ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024

/** The folder a workshop's attachments are saved in, inside its working folder (§6.1). */
export const ATTACHMENTS_FOLDER = "Attachments"

/** A file attached to a message: the copy kept (`mediaId`), and where it is in Files. */
export const AttachedFile = Schema.Struct({
  mediaId: Schema.String,
  /** `image`: a PNG, JPEG, GIF or WebP, also sent as an image to a model that sees images. */
  kind: Schema.Literals(["image", "file"]),
  name: Schema.String,
  path: Schema.String,
  mime: Schema.String,
  size: Schema.Number
})
export type AttachedFile = typeof AttachedFile.Type

export const ShareMode = Schema.Literals(["view", "edit"])
export type ShareMode = typeof ShareMode.Type

/** A folder another account offers you (§1.4): it appears under Shared once you accept. */
export const ShareInvitation = Schema.Struct({
  id: Schema.String,
  ownerHandle: Schema.String,
  ownerName: Schema.String,
  /** The folder's own name. */
  folder: Schema.String,
  mode: ShareMode
})
export type ShareInvitation = typeof ShareInvitation.Type

/** A share of yours whose folder isn't at its path any more (§1.4). */
export const UnavailableShare = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  handle: Schema.String,
  displayName: Schema.String,
  mode: ShareMode,
  /** `bin`: the folder was deleted (and maybe restored); `moved`: its path holds another folder, or nothing. */
  reason: Schema.Literals(["bin", "moved"]),
  /** A folder is at the path now, which Share again would share. */
  folderThere: Schema.Boolean
})
export type UnavailableShare = typeof UnavailableShare.Type

/** What a name is: links and special files are listed with their kind and never opened (§1.1). */
const FileKind = Schema.Literals(["file", "folder", "link", "other"])

export const FileEntry = Schema.Struct({
  name: Schema.String,
  kind: FileKind,
  /** Bytes, for a file. */
  size: Schema.Number,
  mtimeMs: Schema.Number,
  /** A folder of yours shared with other accounts (§1.4): how many. */
  shared: Schema.optionalKey(Schema.Number),
  /** A folder shared with you that its owner moved, replaced or deleted: it opens once they share it again. */
  unavailable: Schema.optionalKey(Schema.Boolean)
})
export type FileEntry = typeof FileEntry.Type

export const FolderListing = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(FileEntry),
  /** More entries than the server lists at once. */
  more: Schema.Boolean,
  /** A folder shared with this account as Can view: every change is refused (§1.4). */
  readOnly: Schema.Boolean,
  /** Where folders shared with you appear (`list`), or one shared with you to `view` or `edit` (§1.4). */
  shared: Schema.optionalKey(Schema.Literals(["list", "view", "edit"])),
  /** Deleting here moves to the bin, with Undo (§1.3); false: it's gone, so the app asks first. */
  bin: Schema.Boolean,
  /** At the top and in Shared: folders other accounts offer you, to accept or decline (§1.4). */
  invitations: Schema.optionalKey(Schema.Array(ShareInvitation)),
  /** At the top: your shares whose folder isn't at their path any more, to share again or stop. */
  unavailableShares: Schema.optionalKey(Schema.Array(UnavailableShare))
})
export type FolderListing = typeof FolderListing.Type

/** When an upload's name is taken: ask (409 with `{ taken: true }`), or one of the batch-wide answers (§1.1). */
export const UploadConflict = Schema.Literals(["ask", "keep", "replace", "skip"])
export type UploadConflict = typeof UploadConflict.Type

export const UploadOutcome = Schema.Struct({
  /** Where it was written: another name under Keep both. */
  path: Schema.String,
  outcome: Schema.Literals(["written", "replaced", "skipped"]),
  /** SHA-256 of what was written, hex (not for a skip): the base of the next editor save. */
  sha256: Schema.optionalKey(Schema.String)
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

export type FileView = "text" | "markdown" | "table" | "html" | "image" | "video" | "audio" | "pdf" | "download"

const VIEWS: ReadonlyArray<readonly [FileView, ReadonlyArray<string>]> = [
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]],
  ["video", ["mp4", "webm", "mov", "m4v", "ogv"]],
  ["audio", ["mp3", "wav", "ogg", "oga", "m4a", "flac", "opus"]],
  ["pdf", ["pdf"]],
  ["markdown", ["md", "markdown"]],
  ["table", ["csv", "tsv"]],
  ["html", ["html", "htm"]],
  [
    "text",
    [
      "txt",
      "json",
      "jsonl",
      "yaml",
      "yml",
      "toml",
      "ini",
      "log",
      "js",
      "mjs",
      "cjs",
      "ts",
      "tsx",
      "jsx",
      "css",
      "scss",
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

/** The viewer a file opens in, by its name: what isn't known downloads (§8.2). SVG is shown as its text. */
export const viewOf = (name: string): FileView => {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf(".")
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower
  for (const [view, extensions] of VIEWS) if (extensions.includes(ext)) return view
  return "download"
}

/** Where folders other accounts share with you appear (§1.4): `/files/Shared/<owner>/<folder>`. */
export const SHARED_FOLDER = "Shared"

/**
 * One account a folder of yours is shared with or offered to. `invited`: not accepted yet, named
 * as you typed it (whether that name is an account isn't said). `unavailable`: the folder at its
 * path isn't the one you shared (moved, replaced, or restored from the bin) until you share it again.
 */
export const FolderShare = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  displayName: Schema.String,
  mode: ShareMode,
  status: Schema.Literals(["active", "invited", "unavailable"])
})
export type FolderShare = typeof FolderShare.Type

export const AnswerInvitationRequest = Schema.Struct({
  invitationId: Schema.String.check(Schema.isMaxLength(64)),
  accept: Schema.Boolean
})

export const ShareRequest = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4096)),
  handle: Schema.String.check(Schema.isMaxLength(128)),
  mode: ShareMode
})

/**
 * A file's earlier content (§1.3). `origin` is what replaced it: `upload`, `editor`, `agent`,
 * `restore`, `delete`; `command` is the content a command left. `actor` is the account that acted
 * when it wasn't you.
 */
export const FileVersionEntry = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
  origin: Schema.String,
  byteSize: Schema.Number,
  restorable: Schema.Boolean,
  actor: Schema.NullOr(Schema.Struct({ handle: Schema.String, displayName: Schema.String }))
})
export type FileVersionEntry = typeof FileVersionEntry.Type

export const RestoredVersion = Schema.Struct({
  path: Schema.String,
  /** The version keeping what the restore replaced: restoring it undoes the restore. */
  keptVersionId: Schema.NullOr(Schema.String)
})
export type RestoredVersion = typeof RestoredVersion.Type
