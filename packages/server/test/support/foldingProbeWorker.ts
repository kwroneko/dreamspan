// Count discarded whole-path position maps and repeated empty evidence decoding.
// The probe wraps JavaScript only in this worker; it runs the real shell handler.
import { parentPort, workerData } from "node:worker_threads"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { readerConnection } from "../../src/db/connection.ts"
import { makeShellReadHandlers } from "../../src/db/shellReads.ts"

const { file, userId, chatId } = workerData as { file: string; userId: UserId; chatId: ChatId }
let positionEntries = 0
let emptyEvidenceParses = 0
let capture = false
const NativeMap = Map
const parse = JSON.parse
const slotIds = new Set<string>()
class ProbedMap<K, V> extends NativeMap<K, V> {
  constructor(entries?: Iterable<readonly [K, V]> | null) {
    super(entries)
    if (capture)
      for (const [key, value] of this) if (typeof value === "number" && slotIds.has(String(key))) positionEntries++
  }
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const row of yield* sql<{ id: string }>`SELECT id FROM slots WHERE chat_id = ${chatId}`) slotIds.add(row.id)
    const handlers = yield* makeShellReadHandlers
    globalThis.Map = ProbedMap
    JSON.parse = function (...args) {
      if (capture && args[0] === "[]") emptyEvidenceParses++
      return Reflect.apply(parse, JSON, args)
    }
    capture = true
    const answer = yield* handlers.ShellLibrary({ userId, recompute: true })
    capture = false
    globalThis.Map = NativeMap
    JSON.parse = parse
    return { positionEntries, emptyEvidenceParses, fresh: answer.fresh.length, forks: answer.forks.length }
  }).pipe(Effect.provide(readerConnection(file)), Effect.scoped)
)
parentPort!.postMessage(result)
