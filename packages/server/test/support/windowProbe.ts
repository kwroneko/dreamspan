// For graph.test.ts's cycle probe: one GetPath through the real read handler, on this
// process's main thread, printing how many entries it returned. A walk that ignored its
// limit would never end, and nothing stops SQLite mid-statement except ending the process.
// So the test runs this in a child process that it can kill.
// Arguments: the data directory, the user id, the chat id, the window size.
import { NodeRuntime } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Logger } from "effect"
import { databaseFile } from "../../src/db/connection.ts"
import { makeReadHandlers } from "../../src/db/reads.ts"

const [dataDir, userId, chatId, limit] = process.argv.slice(2) as [string, UserId, ChatId, string]

Effect.gen(function* () {
  const { GetPath } = yield* makeReadHandlers
  const window = yield* GetPath({ userId, chatId, leafSlotId: null, limit: Number(limit) })
  process.stdout.write(String(window.entries.length))
}).pipe(
  Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })),
  // Silent, so stdout holds only the count: a slow read logs a warning there.
  Effect.provide(Logger.layer([])),
  NodeRuntime.runMain
)
