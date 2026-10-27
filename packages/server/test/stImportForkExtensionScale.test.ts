// A named parent file extended through a long child suffix it shares (ARCHITECTURE.md §13):
// every adopted message passes the naming-collision check, which must not walk the path
// back to the remembered choice each time. Budget: the extension adopts CHILD messages in
// at most EXTENSION_BUDGET times the fresh import of the same messages, and in
// EXTENSION_CEILING_MS at most. Measured (4-CPU VM, idle): about 0.5 times; a walk per
// adopted message took 12.7 times (13.7 s) at 6,000 messages, growing with the length.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"

const CHILD = 6000
const EXTENSION_BUDGET = 3
const EXTENSION_CEILING_MS = 20_000

const bytes = (lines: unknown[]) => new TextEncoder().encode(lines.map((x) => JSON.stringify(x)).join("\n"))
const msg = (mes: string, n: number) => ({
  name: n % 2 ? "User" : "Bot",
  is_user: !!(n % 2),
  mes,
  send_date: 1730000000000 + n
})

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "240 seconds" })(
  "ST fork extension at scale",
  (it) => {
    it.effect(`a named parent adopts a ${CHILD}-message child suffix within budget`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const run = (files: ReadonlyArray<[string, Uint8Array]>) =>
          Effect.gen(function* () {
            const { importId } = yield* api.StartStImport({ unsupported: [] })
            const started = performance.now()
            for (const [path, data] of files) {
              const answer = yield* sendStFile(importId, path, data, { card: "none" })
              assert.notInclude(["failed", "deferred"], answer.outcome)
            }
            return performance.now() - started
          })
        const folder = "LongExtension"
        const common = [msg(folder + " greeting", 0), msg(folder + " user", 1)]
        const outer = [...common, msg(folder + " outer", 2)]
        const child = [...outer, ...Array.from({ length: CHILD }, (_, n) => msg(`${folder} child ${n}`, n + 3))]
        const outerPath = `chats/${folder}/Outer road.jsonl`
        const innerPath = `chats/${folder}/Inner road.jsonl`
        yield* run([
          [`chats/${folder}/main.jsonl`, bytes([{ chat_metadata: {} }, ...common, msg(folder + " main", 2)])],
          [outerPath, bytes([{ chat_metadata: { main_chat: "main" } }, ...outer])]
        ])
        // The control: the same messages as new slots, in the same process and conditions.
        const fresh = yield* run([[innerPath, bytes([{ chat_metadata: { main_chat: "Outer road" } }, ...child])]])
        const extension = yield* run([
          [
            outerPath,
            bytes([
              { chat_metadata: { main_chat: "main" } },
              ...child.slice(0, -1),
              msg(folder + " extended tail", child.length - 1)
            ])
          ]
        ])
        const records = (yield* (yield* Reader).StImportSources({ userId: (yield* api.Whoami()).id })).chats
        const outerRecord = records.find((r) => r.source === outerPath)!
        const innerRecord = records.find((r) => r.source === innerPath)!
        assert.strictEqual(outerRecord.chatId, innerRecord.chatId, "one chat")
        const path = yield* api.ReadPath({
          chatId: outerRecord.chatId,
          leafSlotId: outerRecord.end,
          range: { _tag: "Bottom" },
          limit: 3
        })
        assert.strictEqual(path.entries.at(-1)?.version?.content, folder + " extended tail", "extension imported")
        const measured = `extension ${extension.toFixed(0)} ms, fresh import ${fresh.toFixed(0)} ms`
        assert.isBelow(extension, fresh * EXTENSION_BUDGET, measured)
        assert.isBelow(extension, EXTENSION_CEILING_MS, measured)
      })
    )
  }
)
