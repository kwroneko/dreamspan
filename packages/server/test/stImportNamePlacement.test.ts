import { assert, layer } from "@effect/vitest"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { sendStFile } from "./support/stUpload.ts"

const config = testConfig()
const bytes = (lines: unknown[]) => new TextEncoder().encode(lines.map((x) => JSON.stringify(x)).join("\n"))
const msg = (mes: string, n: number, extra = {}) => ({
  name: n % 2 ? "User" : "Bot",
  is_user: !!(n % 2),
  mes,
  send_date: 1730000000000 + n,
  ...extra
})
const run = Effect.fnUntraced(function* (files: [string, Uint8Array][]) {
  const api = yield* client()
  const { importId } = yield* api.StartStImport({ unsupported: [] })
  for (const [path, data] of files) {
    const answer = yield* sendStFile(importId, path, data, { card: "none" })
    assert.notInclude(["failed", "deferred"], answer.outcome)
  }
  return api
})
const visible = (path: { entries: ReadonlyArray<{ slotId: string; version: unknown }> }) =>
  path.entries.map((e) => ({ slot: e.slotId, version: e.version }))
type Api = Effect.Success<ReturnType<typeof client>>
const snapshot = Effect.fnUntraced(function* (api: Api, source: string) {
  const user = yield* api.Whoami()
  const record = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats.find((r) => r.source === source)!
  const fork = (yield* api.ListForks({ chatId: record.chatId })).find((f) => f.id === record.forkId)!
  const path = yield* api.ReadPath({
    chatId: record.chatId,
    forkId: record.forkId,
    leafSlotId: null,
    range: { _tag: "Bottom" },
    limit: 100
  })
  const [rows] = yield* fixtureSql(
    config.dataDir,
    [{ sql: "SELECT name, name_user FROM forks WHERE id = ?", params: [record.forkId] }],
    { readOnly: true }
  )
  return { record, fork, path, name: rows![0]! }
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "ST file names never name forks (owner, 2026-11-01)",
  (it) => {
    for (const filename of ["Named road", "雪の道 [a.*]", "main - Branch #1", "Branch #42"])
      for (const choice of [undefined, "Local name", ""])
        for (const change of ["swipe", "writer"] as const)
          it.effect(`${filename}: ${change}, local ${JSON.stringify(choice)}`, () =>
            Effect.gen(function* () {
              const folder = `${filename}-${change}-${choice === undefined ? 0 : choice === "" ? 1 : 2}`
              const source = `chats/${folder}/${filename}.jsonl`
              const mainSource = `chats/${folder}/main.jsonl`
              const common = [msg(folder + " greeting", 0), msg(folder + " hello", 1)]
              const main = bytes([{ chat_metadata: {} }, ...common, msg(folder + " main", 2)])
              const branch: Array<ReturnType<typeof msg> & Record<string, unknown>> = [
                ...common,
                msg(folder + " child", 2),
                msg(folder + " tail", 3)
              ]
              const child = () => bytes([{ chat_metadata: { main_chat: "main" } }, ...branch])
              const api = yield* run([
                [mainSource, main],
                [source, child()]
              ])
              const initial = yield* snapshot(api, source)
              assert.deepStrictEqual(initial.name, { name: null, name_user: 0 })
              if (choice !== undefined) yield* api.NameFork({ forkId: initial.record.forkId, name: choice })
              const before = yield* snapshot(api, source)
              const parentBefore = yield* snapshot(api, mainSource)
              // Nest a file through this fork before changing its earlier history.
              const nestedSource = `chats/${folder}/Inner.jsonl`
              const nestedBytes = bytes([
                { chat_metadata: { main_chat: filename } },
                ...branch,
                msg(folder + " nested", 4)
              ])
              yield* run([[nestedSource, nestedBytes]])
              const nestedBefore = yield* snapshot(api, nestedSource)
              const greeting = branch[0]!
              branch[0] =
                change === "writer"
                  ? { ...greeting, is_user: true, name: "User" }
                  : {
                      ...greeting,
                      mes: folder + " changed",
                      swipes: [greeting.mes, folder + " changed"],
                      swipe_id: 1,
                      swipe_info: [{ send_date: greeting.send_date }, { send_date: greeting.send_date }]
                    }
              yield* run([[source, child()]])
              const after = yield* snapshot(api, source)
              assert.strictEqual(after.record.forkId, before.record.forkId)
              assert.deepStrictEqual(after.name, before.name)
              assert.deepStrictEqual(visible((yield* snapshot(api, mainSource)).path), visible(parentBefore.path))
              assert.deepStrictEqual(visible((yield* snapshot(api, nestedSource)).path), visible(nestedBefore.path))
              if (change === "swipe")
                assert.deepStrictEqual(
                  after.path.entries.map((e) => e.slotId),
                  before.path.entries.map((e) => e.slotId)
                )
              else assert.notStrictEqual(after.path.entries[0]!.slotId, before.path.entries[0]!.slotId)
              yield* run([[source, child()]])
              assert.deepStrictEqual(yield* snapshot(api, source), after, "unchanged replay")
              // A different source is its own file/fork, even with identical bytes.
              const renamed = `chats/${folder}/Renamed road.jsonl`
              yield* run([[renamed, child()]])
              const moved = yield* snapshot(api, renamed)
              assert.notStrictEqual(moved.record.forkId, after.record.forkId)
              assert.deepStrictEqual(moved.name, { name: null, name_user: 0 })
              assert.deepStrictEqual((yield* snapshot(api, source)).name, after.name)
            })
          )

    it.effect("checkpoint files sharing the same tip are unnamed forks with independent selections", () =>
      Effect.gen(function* () {
        const lines = [msg("Checkpoint greeting", 0), msg("Checkpoint user", 1)]
        const main = "chats/Checkpoint/main.jsonl"
        const a = "chats/Checkpoint/Before duel.jsonl"
        const b = "chats/Checkpoint/After duel.jsonl"
        const api = yield* run([
          [main, bytes([{ chat_metadata: {} }, ...lines])],
          [a, bytes([{ chat_metadata: { main_chat: "main", variables: { scene: "duel" } } }, ...lines])],
          [b, bytes([{ chat_metadata: { main_chat: "main" } }, ...lines])]
        ])
        const checkpoints = yield* Effect.all([snapshot(api, main), snapshot(api, a), snapshot(api, b)])
        assert.strictEqual(new Set(checkpoints.map((c) => c.record.forkId)).size, 3)
        assert.strictEqual(new Set(checkpoints.map((c) => c.fork.tipSlotId)).size, 1)
        assert.deepStrictEqual(
          checkpoints.map((c) => c.fork.name),
          [null, null, null]
        )
        const slot = checkpoints[1]!.path.entries[0]!
        yield* api.EditVersion({
          forkId: checkpoints[1]!.record.forkId,
          slotId: slot.slotId,
          sourceVersionId: slot.version.id,
          expectedRowVersion: slot.rowVersion,
          content: "Local checkpoint edit"
        })
        assert.strictEqual((yield* snapshot(api, b)).path.entries[0]!.version.content, "Checkpoint greeting")
        const user = yield* api.Whoami()
        const events = yield* (yield* Reader).StateEventsAt({
          userId: user.id,
          chatId: checkpoints[0]!.record.chatId,
          slotId: checkpoints[1]!.record.end,
          forkId: checkpoints[1]!.record.forkId
        })
        assert.strictEqual(foldState(events).vars.scene, "duel")
        const changed = {
          ...lines[0]!,
          mes: "ST checkpoint change",
          swipes: [lines[0]!.mes, "ST checkpoint change"],
          swipe_id: 1,
          swipe_info: [{ send_date: lines[0]!.send_date }, { send_date: lines[0]!.send_date }]
        }
        yield* run([[b, bytes([{ chat_metadata: { main_chat: "main" } }, changed, lines[1]!])]])
        assert.strictEqual((yield* snapshot(api, b)).path.entries[0]!.version.content, "ST checkpoint change")
        assert.strictEqual((yield* snapshot(api, a)).path.entries[0]!.version.content, "Local checkpoint edit")
        assert.strictEqual((yield* snapshot(api, main)).path.entries[0]!.version.content, "Checkpoint greeting")
        const bBefore = yield* snapshot(api, b)
        yield* run([[main, bytes([{ chat_metadata: {} }, ...lines, msg("Main extension", 2)])]])
        assert.strictEqual((yield* snapshot(api, b)).fork.tipSlotId, bBefore.fork.tipSlotId)
        assert.strictEqual((yield* snapshot(api, main)).path.entries.at(-1)!.version.content, "Main extension")
      })
    )
  }
)
