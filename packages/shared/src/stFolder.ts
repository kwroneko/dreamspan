// A SillyTavern data folder as the importer sees it (DESIGN §1.4, DATA-MODEL §14): which of
// its files are read, and what each one is. The client uses it to pick what to upload from
// a chosen folder, and the server uses it again on every uploaded path, so a path that isn't
// one of these is refused whatever the client sent. Folder names follow ST's
// USER_DIRECTORY_TEMPLATE (src/constants.js).

/** The largest piece of a chat file sent at once, cut at a line end (ARCHITECTURE.md §13). */
export const ST_CHAT_PART_BYTES = 8 * 1024 * 1024

/** A path inside one user's ST folder (`data/<handle>/`), and what the importer does with it. */
export type StFile =
  | { readonly kind: "settings" }
  | { readonly kind: "persona_avatar"; readonly file: string }
  | { readonly kind: "card"; readonly file: string }
  | { readonly kind: "world"; readonly name: string }
  | { readonly kind: "preset"; readonly name: string }
  | { readonly kind: "group"; readonly file: string }
  /** `folder` is the card's avatar file name without `.png`, as ST names chat folders. */
  | { readonly kind: "chat"; readonly folder: string; readonly name: string }
  | { readonly kind: "group_chat"; readonly name: string }
  /** Text-completion presets and templates: listed, never read (DESIGN §1.2). */
  | { readonly kind: "unsupported"; readonly what: string }

const UNSUPPORTED: Readonly<Record<string, string>> = {
  "TextGen Settings": "text-completion preset",
  "KoboldAI Settings": "KoboldAI preset",
  "NovelAI Settings": "NovelAI preset",
  instruct: "instruct template",
  context: "context template",
  sysprompt: "system prompt template",
  reasoning: "reasoning template"
}

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i

/** A path segment that can only name a file or folder where it stands. */
const safeSegment = (segment: string) =>
  segment !== "" &&
  segment !== "." &&
  segment !== ".." &&
  segment.length <= 255 &&
  // Control characters, and the separators of other systems.
  !/[\p{Cc}\\:]/u.test(segment)

const stem = (file: string, extension: RegExp) => file.replace(extension, "")

/**
 * What a path relative to a user's ST folder is, or null for anything the importer
 * doesn't read: backups, thumbnails, images, extensions, secrets and the rest.
 */
export const classifyStPath = (path: string): StFile | null => {
  if (path.length > 1024) return null
  const segments = path.split("/")
  if (!segments.every(safeSegment)) return null
  const [top, second, third] = segments
  if (segments.length === 1) return top === "settings.json" ? { kind: "settings" } : null
  if (segments.length === 2) {
    const file = second!
    if (top === "User Avatars" && IMAGE.test(file)) return { kind: "persona_avatar", file }
    if (top === "characters" && /\.(png|json|charx)$/i.test(file)) return { kind: "card", file }
    if (top === "worlds" && /\.json$/i.test(file)) return { kind: "world", name: stem(file, /\.json$/i) }
    if (top === "OpenAI Settings" && /\.json$/i.test(file)) return { kind: "preset", name: stem(file, /\.json$/i) }
    if (top === "groups" && /\.json$/i.test(file)) return { kind: "group", file }
    if (top === "group chats" && /\.jsonl$/i.test(file)) return { kind: "group_chat", name: stem(file, /\.jsonl$/i) }
    if (Object.hasOwn(UNSUPPORTED, top!) && /\.json$/i.test(file))
      return { kind: "unsupported", what: UNSUPPORTED[top!]! }
    return null
  }
  if (segments.length === 3 && top === "chats" && /\.jsonl$/i.test(third!)) {
    return { kind: "chat", folder: second!, name: stem(third!, /\.jsonl$/i) }
  }
  return null
}

/** Where a chat file's parent is, for a branch or checkpoint naming it (`main_chat`). */
export const stParentPath = (file: Extract<StFile, { kind: "chat" | "group_chat" }>, mainChat: string) =>
  file.kind === "chat" ? `chats/${file.folder}/${mainChat}.jsonl` : `group chats/${mainChat}.jsonl`

/**
 * Chat files with each parent before the branches that name it, so a branch rarely has to
 * be sent again: otherwise a chain of branches sorted the wrong way would take a round of
 * retries per link. `mainChat` is what the file's header names, when the client read it.
 * Files keep their order otherwise; a cycle is broken where it's found.
 */
export const orderStChats = <A extends { readonly path: string; readonly mainChat: string | null }>(
  chats: ReadonlyArray<A>
): ReadonlyArray<A> => {
  const byPath = new Map(chats.map((chat) => [chat.path, chat]))
  const done = new Set<string>()
  const ordered: Array<A> = []
  for (const chat of chats) {
    // Walk up to the oldest ancestor not placed yet, then place the chain from there down.
    const chain: Array<A> = []
    const seen = new Set<string>()
    let at: A | undefined = chat
    while (at !== undefined && !done.has(at.path) && !seen.has(at.path)) {
      seen.add(at.path)
      chain.push(at)
      const file = classifyStPath(at.path)
      const parent: string | null =
        at.mainChat === null || (file?.kind !== "chat" && file?.kind !== "group_chat")
          ? null
          : stParentPath(file, at.mainChat)
      at = parent === null ? undefined : byPath.get(parent)
    }
    for (const entry of chain.toReversed()) {
      done.add(entry.path)
      ordered.push(entry)
    }
  }
  return ordered
}

/** The order files go in: what chats link to comes before the chats. */
export const ST_FILE_ORDER: ReadonlyArray<StFile["kind"]> = [
  "settings",
  "persona_avatar",
  "card",
  "world",
  "preset",
  "group",
  "chat",
  "group_chat"
]

/** One user's folder inside what was picked: its prefix, and a name for it. */
export interface StRoot {
  /** The path prefix of the user's folder, `""` or ending in `/`. */
  readonly prefix: string
  /** ST's handle for a `data/<handle>/` folder, otherwise the folder's own name. */
  readonly name: string
  readonly files: number
}

/**
 * The ST user folders among the picked paths. A path belongs to the deepest prefix under
 * which it's a file the importer reads, so the whole ST install, its `data` folder, or one
 * user's folder can be picked. ST's multi-user layout gives one root per handle.
 */
export const findStRoots = (paths: ReadonlyArray<string>): ReadonlyArray<StRoot> => {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const segments = path.split("/")
    for (let start = segments.length - 1; start >= 0; start--) {
      const rest = segments.slice(start).join("/")
      const file = classifyStPath(rest)
      if (file === null) continue
      const prefix = segments.slice(0, start).join("/")
      const key = prefix === "" ? "" : `${prefix}/`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      break
    }
  }
  return [...counts.entries()]
    .map(([prefix, files]) => ({ prefix, files, name: prefix.split("/").filter(Boolean).pop() ?? "" }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
}
