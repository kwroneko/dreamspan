// What an ST folder import sends, and in what order (ARCHITECTURE.md §13): the files of the
// chosen ST user's folder that the import reads, in `ST_FILE_ORDER`, chats with each parent
// before its branches. The server plans a folder it reads from a path with it, and the
// browser plans a folder picked in it, so both send the same files in the same order.
import { classifyStPath, orderStChats, ST_FILE_ORDER, type StFile } from "./stFolder.ts"

type StSentKind = Exclude<StFile["kind"], "unsupported">

/** A file the import sends, by its path in the ST user's folder, and what it was found as. */
export interface StPlanned<A> {
  readonly path: string
  readonly kind: StSentKind
  readonly size: number
  readonly item: A
}

/**
 * The files under `prefix` (one of `findStRoots`) that the import reads, in the order they
 * go (not yet with parents before branches: `orderStBranches`), and those it lists unread.
 */
export const stPlan = <A extends { readonly path: string; readonly size: number }>(
  found: ReadonlyArray<A>,
  prefix: string
) => {
  const send: Array<StPlanned<A>> = []
  const unsupported: Array<string> = []
  for (const item of found) {
    if (!item.path.startsWith(prefix)) continue
    const path = item.path.slice(prefix.length)
    const kind = classifyStPath(path)?.kind
    if (kind === "unsupported") unsupported.push(path)
    else if (kind !== undefined) send.push({ path, kind, size: item.size, item })
  }
  send.sort((a, b) => ST_FILE_ORDER.indexOf(a.kind) - ST_FILE_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path))
  return { send, unsupported }
}

const isChat = (entry: { readonly kind: StSentKind }) => entry.kind === "chat" || entry.kind === "group_chat"

/**
 * The plan with each chat's parent before its branches (`orderStChats`), so a branch is
 * rarely sent twice. `mainChat` is the parent a chat file names, from its first line.
 */
export const orderStBranches = <P extends StPlanned<unknown>>(
  send: ReadonlyArray<P>,
  mainChat: (entry: P) => string | null
): ReadonlyArray<P> => {
  const ordered = orderStChats(
    send.filter(isChat).map((entry) => ({ entry, path: entry.path, mainChat: mainChat(entry) }))
  )
  let next = 0
  return send.map((entry) => (isChat(entry) ? ordered[next++]!.entry : entry))
}

/** How much of a chat's start is read for the parent it names. */
export const ST_HEAD_BYTES = 64 * 1024

/** The parent a chat file names (`chat_metadata.main_chat`), from its start; null for none. */
export const stMainChat = (head: string): string | null => {
  try {
    const header: unknown = JSON.parse(head.split("\n", 1)[0]!)
    const metadata =
      typeof header === "object" && header !== null ? (header as Record<string, unknown>).chat_metadata : null
    const name =
      typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>).main_chat : null
    return typeof name === "string" && name !== "" ? name : null
  } catch {
    return null
  }
}
