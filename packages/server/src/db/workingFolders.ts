// The working folders a user picked (spec/FILES-AND-ENVIRONMENT.md §2.3): per assistant card
// (`workshop.cardFolders`, at most 2,000 entries, the oldest dropped first) and the last few
// (`workshop.recentFolders`, newest first, at most 5). A new workshop starts in its card's folder,
// else the folder of the card it was forked from, else the last folder picked, else the top.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { putUserSetting, readSetting } from "./settings.ts"
import type { ReadOps, WriteOps } from "./ops.ts"
import { query, transaction } from "./tx.ts"
import { SqlClient as Sql } from "effect/sql"

const CARD_FOLDERS = "workshop.cardFolders"
const RECENT_FOLDERS = "workshop.recentFolders"
const FOLDER_MOVES = "workshop.folderMoves"
/** Moves kept at most, the oldest dropped first. */
const MAX_MOVES = 200
const MAX_CARDS = 2000
const MAX_RECENT = 5
/** How many forks back a card's memory is looked for. */
const FORK_DEPTH = 8

interface Folder {
  readonly path: string
  readonly inode: number | null
}
type CardFolders = Record<string, Folder & { readonly at: number }>

const cardFoldersOf = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.map(readSetting(sql, "user", userId, CARD_FOLDERS), ({ value }) => (value ?? {}) as CardFolders)

const recentOf = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.map(readSetting(sql, "user", userId, RECENT_FOLDERS), ({ value }) => (value ?? []) as ReadonlyArray<Folder>)

interface FolderMove {
  readonly from: string
  readonly to: string
}

const movesOf = (sql: SqlClient.SqlClient, userId: string) =>
  Effect.map(readSetting(sql, "user", userId, FOLDER_MOVES), ({ value }) => (value ?? []) as ReadonlyArray<FolderMove>)

/** `path` with the folder `from` (or a folder under it) now at `to`; unchanged when not under it. */
const moved = (path: string, from: string, to: string) =>
  path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path

/** The remembered folder of a card, or of the card it was forked from (up a few forks); null: none. */
const cardFolderOf = (sql: SqlClient.SqlClient, userId: string, cardId: string | null) =>
  Effect.gen(function* () {
    if (cardId === null) return null
    const folders = yield* cardFoldersOf(sql, userId)
    let at: string | null = cardId
    for (let depth = 0; at !== null && depth < FORK_DEPTH; depth++) {
      const found: (Folder & { at: number }) | undefined = folders[at]
      if (found) return { path: found.path, inode: found.inode }
      const [row]: ReadonlyArray<{ parent: string | null }> = yield* sql<{ parent: string | null }>`
        SELECT forked_from_entity_id AS parent FROM entities WHERE id = ${at} AND owner_user_id = ${userId}`
      at = row?.parent ?? null
    }
    return null
  })

/** Where a new workshop with this assistant card starts (§2.3); null: the top of Files. */
export const startingFolder = (sql: SqlClient.SqlClient, userId: string, cardId: string | null) =>
  Effect.gen(function* () {
    const card = yield* cardFolderOf(sql, userId, cardId)
    if (card) return card
    return (yield* recentOf(sql, userId))[0] ?? null
  })

export const makeWorkingFolderWriteHandlers = Effect.gen(function* () {
  const sql = yield* Sql.SqlClient
  return {
    RememberWorkshopFolder: ({ userId, cardId, path, inode }) =>
      Effect.gen(function* () {
        const folder = { path, inode }
        if (cardId !== null) {
          const folders = { ...(yield* cardFoldersOf(sql, userId)), [cardId]: { ...folder, at: Date.now() } }
          const entries = Object.entries(folders).sort((a, b) => b[1].at - a[1].at)
          yield* putUserSetting(sql, userId, CARD_FOLDERS, Object.fromEntries(entries.slice(0, MAX_CARDS)))
        }
        const recent = (yield* recentOf(sql, userId)).filter((entry) => entry.path !== path)
        yield* putUserSetting(sql, userId, RECENT_FOLDERS, [folder, ...recent].slice(0, MAX_RECENT))
      }).pipe(transaction(sql, "RememberWorkshopFolder")),
    // The settings' paths follow the move (their inodes stay: a move keeps them); branches'
    // stored folders are state events, never rewritten, so the move is kept for finding them.
    RecordFolderMove: ({ userId, from, to }) =>
      Effect.gen(function* () {
        if (from === to) return
        const cards = yield* cardFoldersOf(sql, userId)
        if (Object.values(cards).some((folder) => moved(folder.path, from, to) !== folder.path))
          yield* putUserSetting(
            sql,
            userId,
            CARD_FOLDERS,
            Object.fromEntries(
              Object.entries(cards).map(([card, folder]) => [card, { ...folder, path: moved(folder.path, from, to) }])
            )
          )
        const recent = yield* recentOf(sql, userId)
        if (recent.some((folder) => moved(folder.path, from, to) !== folder.path))
          yield* putUserSetting(
            sql,
            userId,
            RECENT_FOLDERS,
            recent
              .map((folder) => ({ ...folder, path: moved(folder.path, from, to) }))
              .filter((folder, i, all) => all.findIndex((other) => other.path === folder.path) === i)
          )
        const moves = yield* movesOf(sql, userId)
        yield* putUserSetting(sql, userId, FOLDER_MOVES, [...moves, { from, to }].slice(-MAX_MOVES))
      }).pipe(transaction(sql, "RecordFolderMove"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})

export const makeWorkingFolderReadHandlers = Effect.gen(function* () {
  const sql = yield* Sql.SqlClient
  return {
    WorkshopFolderMemory: ({ userId, cardId }) =>
      Effect.gen(function* () {
        return {
          recent: yield* recentOf(sql, userId),
          card: yield* cardFolderOf(sql, userId, cardId),
          moves: yield* movesOf(sql, userId)
        }
      }).pipe(query("WorkshopFolderMemory"))
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})
