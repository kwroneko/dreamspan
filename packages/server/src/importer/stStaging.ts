// Where an ST chat's messages wait while it has no user message yet (ARCHITECTURE.md §13): a
// file per chat under `DATA_DIR/st-staging/<import>/`, so a long greeting-only chat is
// skipped without ever being written to a chat, and the outcome doesn't depend on how its
// parts fall. Nothing here touches the database.
import { createReadStream } from "node:fs"
import { appendFile, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"

const STAGING = "st-staging"

/** A batch of a chat's messages, as the format worker made it, with its speakers' cards. */
export interface StagedBatch {
  readonly batch: { readonly messagesJson: string; readonly speakers: ReadonlyArray<string> }
  readonly speakers: ReadonlyMap<string, EntityId | null>
}

/** An import's own staging folder; its name is the import's id, which the server made. */
export const stagingDir = (dataDir: string, importId: string) => join(dataDir, STAGING, importId)

/** Appends batches to a staging file: each is its messages' JSON line, then its speakers'. */
export const stage = (file: string, batches: ReadonlyArray<StagedBatch>) =>
  Effect.tryPromise(async () => {
    await mkdir(join(file, ".."), { recursive: true })
    const lines = batches.map(
      ({ batch, speakers }) =>
        `${batch.messagesJson}\n${JSON.stringify(batch.speakers.map((key) => [key, speakers.get(key) ?? null]))}\n`
    )
    await appendFile(file, lines.join(""))
  })

/** Reads a staging file's batches back, in order, one at a time. */
export const replay = <E, R>(file: string, each: (staged: StagedBatch) => Effect.Effect<void, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createInterface({ input: createReadStream(file), crlfDelay: Infinity })),
    (lines) =>
      Effect.gen(function* () {
        const iterator = lines[Symbol.asyncIterator]()
        for (;;) {
          const messages = yield* Effect.promise(() => iterator.next())
          if (messages.done) return
          const speakers = yield* Effect.promise(() => iterator.next())
          if (speakers.done) return
          const entries = JSON.parse(speakers.value) as Array<[string, EntityId | null]>
          yield* each({
            batch: { messagesJson: messages.value, speakers: entries.map(([key]) => key) },
            speakers: new Map(entries)
          })
        }
      }),
    (lines) => Effect.sync(() => lines.close())
  )

/** Removes a staging file or folder, if it's there. */
export const unstage = (path: string) => Effect.promise(() => rm(path, { recursive: true, force: true }))

/** Removes the staging folders of imports that are gone: all of them at startup. */
export const sweepStaging = (dataDir: string, live: ReadonlySet<string>) =>
  Effect.promise(async () => {
    const entries = await readdir(join(dataDir, STAGING)).catch(() => [])
    let removed = 0
    for (const entry of entries) {
      if (live.has(entry)) continue
      await rm(join(dataDir, STAGING, entry), { recursive: true, force: true })
      removed++
    }
    return removed
  })
