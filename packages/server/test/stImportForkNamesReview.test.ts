// Regression reproductions from the fork-name review; all chat data is synthetic.
import { assert, describe, it, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import { stForkName } from "../src/importer/stMapping.ts"
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
    const result = yield* sendStFile(importId, path, data, { card: "none" })
    assert.notInclude(["failed", "deferred"], result.outcome)
  }
  return api
})
const nameOf = Effect.fnUntraced(function* (content: string) {
  const [rows] = yield* fixtureSql(
    config.dataDir,
    [
      {
        sql: "SELECT s.id, s.branch_name AS name FROM slots s JOIN versions v ON v.id = s.selected_version_id WHERE v.content = ? ORDER BY s.id DESC",
        params: [content]
      }
    ],
    { readOnly: true }
  )
  return rows![0]! as { id: SlotId; name: string | null }
})
const pair = (folder: string, name: string): [string, Uint8Array][] => {
  const common = [msg(folder + " greeting", 0), msg(folder + " hello", 1)]
  return [
    [`chats/${folder}/main.jsonl`, bytes([{ chat_metadata: {} }, ...common, msg(folder + " main", 2)])],
    [
      `chats/${folder}/${name}.jsonl`,
      bytes([{ chat_metadata: { main_chat: "main" } }, ...common, msg(folder + " fork", 2), msg(folder + " reply", 3)])
    ]
  ]
}

describe("ST fork name preservation", () => {
  it("keeps a user-supplied current ST checkpoint called Branch #42", () => {
    for (const name of ["Branch #42", "Checkpoint #42", "Bookmark #42", "2026-3-14@09h26m53s589ms"]) {
      assert.strictEqual(stForkName(name), name)
    }
  })
  it("keeps suffixes that cannot be generated from the actual parent", () => {
    for (const name of [
      "Unrelated - Branch #42",
      "Unrelated - Checkpoint #42",
      "main - Bookmark #42",
      "main - Branch #0"
    ]) {
      assert.strictEqual(stForkName(name, "main"), name)
      assert.strictEqual(stForkName(name), name)
    }
  })
  it("recognizes current names only with their actual parent's generator rules", () => {
    for (const [parent, name] of [
      ["main", "main - Branch #1"],
      ["main", "main - Checkpoint #2"],
      ["main - Branch #9", "main - Branch #10"],
      ["main - Checkpoint #9", "main - Checkpoint #10"],
      ["Branch #2 - main", "main - Branch #1"],
      ["Checkpoint #2 - main", "main - Checkpoint #1"],
      ["main - Branch #2", "main - Branch #2 - Checkpoint #1"],
      ["雪の道 [a.*]", "雪の道 [a.*] - Branch #1"]
    ]) {
      assert.isNull(stForkName(name!, parent!))
      assert.strictEqual(stForkName(name!, "different parent"), name)
      assert.strictEqual(stForkName(name!), name)
    }
  })
  it("preserves non-ASCII and does not strip an unrelated date format", () => {
    assert.strictEqual(stForkName("雪の道 — Café 🌙 - 2026-03-14"), "雪の道 — Café 🌙 - 2026-03-14")
    assert.strictEqual(stForkName("🌙".repeat(60)), "🌙".repeat(50))
  })
})
layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "ST fork name reimport regressions",
  (it) => {
    it.effect("imports user-entered bare and unrelated generated-looking names", () =>
      Effect.gen(function* () {
        for (const [index, name] of [
          "Branch #42",
          "Checkpoint #42",
          "Bookmark #42",
          "2026-3-14@09h26m53s589ms",
          "Other - Branch #42",
          "main - Bookmark #42",
          "main - Branch #0"
        ].entries()) {
          const folder = `UserName${index}`
          yield* run(pair(folder, name))
          assert.strictEqual((yield* nameOf(`${folder} fork`)).name, name)
        }
      })
    )
    it.effect("does not restore an app-cleared name after ST renames the file", () =>
      Effect.gen(function* () {
        const files = pair("Cleared", "Old ST name")
        const api = yield* run(files)
        const slot = yield* nameOf("Cleared fork")
        yield* api.NameBranch({ slotId: slot.id, name: "My app name" })
        yield* api.NameBranch({ slotId: slot.id, name: "" })
        assert.isNull((yield* nameOf("Cleared fork")).name)
        yield* run([files[0]!, ["chats/Cleared/New ST name.jsonl", files[1]![1]]])
        assert.strictEqual((yield* nameOf("Cleared fork")).id, slot.id)
        assert.isNull((yield* nameOf("Cleared fork")).name)
      })
    )
    for (const [index, localName] of [null, "Local road", ""].entries()) {
      const label =
        localName === null
          ? "names the new divergence"
          : `keeps local name ${JSON.stringify(localName)} on the new divergence`
      it.effect(`${label} when reimport changes a shared-prefix swipe`, () =>
        Effect.gen(function* () {
          const folder = `Shared${index}`
          const files = pair(folder, "Named road")
          const api = yield* run(files)
          const old = yield* nameOf(`${folder} fork`)
          assert.strictEqual(old.name, "Named road")
          if (localName !== null) yield* api.NameBranch({ slotId: old.id, name: localName })
          const expected = localName === "" ? undefined : (localName ?? "Named road")
          const user = yield* api.Whoami()
          const reader = yield* Reader
          const source = Effect.fnUntraced(function* () {
            return (yield* reader.StImportSources({ userId: user.id })).chats.find((r) => r.source === files[1]![0])!
          })
          const original = yield* source()
          const oldPath = yield* api.ReadPath({
            chatId: original.chatId,
            leafSlotId: original.end,
            range: { _tag: "Bottom" },
            limit: 100
          })
          const changed = bytes([
            { chat_metadata: { main_chat: "main" } },
            msg(`Changed ${folder} greeting`, 0, {
              swipes: [`${folder} greeting`, `Changed ${folder} greeting`],
              swipe_id: 1,
              swipe_info: [{ send_date: 1730000000000 }, { send_date: 1730000000000 }]
            }),
            msg(`${folder} hello`, 1),
            msg(`${folder} fork`, 2),
            msg(`${folder} reply`, 3)
          ])
          // Also exercise upgrading records written with only the old once-per-record flag.
          if (localName === null)
            yield* fixtureSql(config.dataDir, [
              {
                sql: "UPDATE jobs SET payload_json = json_remove(payload_json, '$.nameSlot') WHERE id = ?",
                params: [original.recordId]
              }
            ])
          yield* run([files[0]!, [files[1]![0], changed]])
          const record = yield* source()
          const path = yield* api.ReadPath({
            chatId: record.chatId,
            leafSlotId: record.end,
            range: { _tag: "Bottom" },
            limit: 100
          })
          assert.strictEqual(path.entries[0]!.version.content, `Changed ${folder} greeting`)
          assert.strictEqual(path.entries[0]!.branchName, expected)
          assert.deepStrictEqual(
            path.entries.slice(1).map((e) => e.branchName),
            [undefined, undefined, undefined]
          )
          const menu = yield* api.ListBranches({ slotId: oldPath.entries[0]!.slotId })
          assert.strictEqual(menu.find((b) => b.slotId === path.entries[0]!.slotId)?.name, expected ?? null)
          // The old path, including its local naming choice, remains intact.
          const originalAfter = yield* api.ReadPath({
            chatId: original.chatId,
            leafSlotId: original.end,
            range: { _tag: "Bottom" },
            limit: 100
          })
          const contents = (entries: typeof oldPath.entries) =>
            entries.map((e) => ({ slot: e.slotId, name: e.branchName, version: e.version }))
          assert.deepStrictEqual(contents(originalAfter.entries), contents(oldPath.entries))
          yield* run([files[0]!, [files[1]![0], changed]])
          assert.deepStrictEqual(
            yield* api.ReadPath({
              chatId: record.chatId,
              leafSlotId: (yield* source()).end,
              range: { _tag: "Bottom" },
              limit: 100
            }),
            path
          )
        })
      )
    }
    for (const [index, localName] of [null, "My replacement", ""].entries()) {
      it.effect(`names the replacement path after a writer change (${JSON.stringify(localName)})`, () =>
        Effect.gen(function* () {
          const folder = `WriterReplacement${index}`
          const files = pair(folder, "Named road")
          const api = yield* run(files)
          const old = yield* nameOf(`${folder} fork`)
          if (localName !== null) yield* api.NameBranch({ slotId: old.id, name: localName })
          const user = yield* api.Whoami()
          const reader = yield* Reader
          const source = Effect.fnUntraced(function* () {
            return (yield* reader.StImportSources({ userId: user.id })).chats.find((r) => r.source === files[1]![0])!
          })
          const original = yield* source()
          const originalPath = yield* api.ReadPath({
            chatId: original.chatId,
            leafSlotId: original.end,
            range: { _tag: "Bottom" },
            limit: 100
          })
          // A different writer cannot reuse a recorded slot. It starts a new path
          // without copying a suffix, even though text and timestamps are unchanged.
          const changed = bytes([
            { chat_metadata: { main_chat: "main" } },
            msg(`${folder} greeting`, 0, { is_user: true, name: "User" }),
            msg(`${folder} hello`, 1),
            msg(`${folder} fork`, 2),
            msg(`${folder} reply`, 3)
          ])
          const contents = (path: typeof originalPath) =>
            path.entries.map((e) => ({ slot: e.slotId, name: e.branchName, version: e.version }))
          let replacement: typeof originalPath | undefined
          for (let pass = 0; pass < 2; pass++) {
            yield* run([files[0]!, [files[1]![0], changed]])
            const record = yield* source()
            const path = yield* api.ReadPath({
              chatId: record.chatId,
              leafSlotId: record.end,
              range: { _tag: "Bottom" },
              limit: 100
            })
            assert.notStrictEqual(path.entries[0]!.slotId, originalPath.entries[0]!.slotId)
            assert.strictEqual(path.entries[0]!.version.writer, "human")
            const [rows] = yield* fixtureSql(
              config.dataDir,
              [
                {
                  sql: "SELECT branch_name, branch_name_user FROM slots WHERE id = ?",
                  params: [path.entries[0]!.slotId]
                }
              ],
              { readOnly: true }
            )
            const expected = localName === "" ? null : (localName ?? "Named road")
            assert.strictEqual(rows![0]!.branch_name, expected, "the first divergent slot must carry the name")
            assert.strictEqual(
              rows![0]!.branch_name_user,
              localName === null ? 0 : 1,
              "the replacement must retain local naming provenance"
            )
            assert.deepStrictEqual(
              path.entries.slice(1).map((e) => e.branchName),
              [undefined, undefined, undefined]
            )
            const menu = yield* api.ListBranches({ slotId: originalPath.entries[0]!.slotId })
            assert.strictEqual(menu.find((b) => b.slotId === path.entries[0]!.slotId)?.name, expected)
            const oldAfter = yield* api.ReadPath({
              chatId: original.chatId,
              leafSlotId: original.end,
              range: { _tag: "Bottom" },
              limit: 100
            })
            assert.deepStrictEqual(contents(oldAfter), contents(originalPath))
            if (replacement !== undefined) assert.deepStrictEqual(path, replacement)
            replacement = path
          }
        })
      )
    }
    for (const [index, localName] of [null, "My inner", ""].entries()) {
      it.effect(
        `parent movement preserves nested naming and the shared main prefix (${JSON.stringify(localName)})`,
        () =>
          Effect.gen(function* () {
            const folder = `MoveParent${index}`
            const files = pair(folder, "Outer road")
            files.push([
              `chats/${folder}/Inner road.jsonl`,
              bytes([
                { chat_metadata: { main_chat: "Outer road" } },
                msg(`${folder} greeting`, 0),
                msg(`${folder} hello`, 1),
                msg(`${folder} fork`, 2),
                msg(`${folder} inner reply`, 3)
              ])
            ])
            const api = yield* run(files)
            const originalGreeting = yield* nameOf(`${folder} greeting`)
            const inner = yield* nameOf(`${folder} inner reply`)
            assert.isNull(originalGreeting.name)
            assert.strictEqual(inner.name, "Inner road")
            if (localName !== null) yield* api.NameBranch({ slotId: inner.id, name: localName })
            const user = yield* api.Whoami()
            const reader = yield* Reader
            const paths = Effect.fnUntraced(function* () {
              const records = (yield* reader.StImportSources({ userId: user.id })).chats
              return yield* Effect.forEach([files[0]!, files[2]!], ([source]) => {
                const record = records.find((r) => r.source === source)!
                return api.ReadPath({
                  chatId: record.chatId,
                  leafSlotId: record.end,
                  range: { _tag: "Bottom" },
                  limit: 100
                })
              })
            })
            const naming = () =>
              fixtureSql(
                config.dataDir,
                [
                  {
                    sql: "SELECT id, branch_name, branch_name_user FROM slots WHERE id IN (?, ?)",
                    params: [originalGreeting.id, inner.id]
                  }
                ],
                { readOnly: true }
              )
            const before = yield* paths()
            const namesBefore = yield* naming()
            const changed = bytes([
              { chat_metadata: { main_chat: "main" } },
              msg(`Changed ${folder} greeting`, 0, {
                swipes: [`${folder} greeting`, `Changed ${folder} greeting`],
                swipe_id: 1,
                swipe_info: [{ send_date: 1730000000000 }, { send_date: 1730000000000 }]
              }),
              msg(`${folder} hello`, 1),
              msg(`${folder} fork`, 2),
              msg(`${folder} reply`, 3)
            ])
            const reimport: [string, Uint8Array][] = [files[0]!, [files[1]![0], changed], files[2]!]
            for (let pass = 0; pass < 2; pass++) {
              yield* run(reimport)
              const after = yield* paths()
              const expected = localName === "" ? undefined : (localName ?? "Inner road")
              assert.strictEqual(
                after[1]!.entries.filter((e) => e.branchName === expected && e.slotId === inner.id).length,
                1
              )
              if (expected !== undefined)
                assert.strictEqual(after[1]!.entries.filter((e) => e.branchName === expected).length, 1)
              assert.deepStrictEqual(yield* naming(), namesBefore, "main and nested naming provenance must stay intact")
              // Sibling counts change when the outer path is copied; these paths' slots,
              // names and selected versions must not change, including on replay.
              const contents = (path: (typeof before)[number]) =>
                path.entries.map((e) => ({ slot: e.slotId, name: e.branchName, version: e.version }))
              assert.deepStrictEqual(after.map(contents), before.map(contents))
            }
          })
      )
    }
    it.effect("keeps nested names on their respective divergence slots", () =>
      Effect.gen(function* () {
        const files = pair("Nested", "Outer road")
        files.push([
          "chats/Nested/内側の道.jsonl",
          bytes([
            { chat_metadata: { main_chat: "Outer road" } },
            msg("Nested greeting", 0),
            msg("Nested hello", 1),
            msg("Nested fork", 2),
            msg("nested inner", 3)
          ])
        ])
        yield* run(files)
        assert.strictEqual((yield* nameOf("Nested fork")).name, "Outer road")
        assert.strictEqual((yield* nameOf("nested inner")).name, "内側の道")
      })
    )
    it.effect("keeps a nonempty app name after ST renames the fork", () =>
      Effect.gen(function* () {
        const files = pair("Kept", "Old name")
        const api = yield* run(files)
        const slot = yield* nameOf("Kept fork")
        yield* api.NameBranch({ slotId: slot.id, name: "App name" })
        yield* run([files[0]!, ["chats/Kept/New name.jsonl", files[1]![1]]])
        assert.strictEqual((yield* nameOf("Kept fork")).name, "App name")
      })
    )
    it.effect("import naming preserves the ST selection baseline and local naming preserves a mismatch", () =>
      Effect.gen(function* () {
        const files = pair("Baseline", "Baseline road")
        const api = yield* run(files)
        const slot = yield* nameOf("Baseline fork")
        const select = (text: string) =>
          bytes([
            { chat_metadata: { main_chat: "main" } },
            msg("Baseline greeting", 0),
            msg("Baseline hello", 1),
            msg(text, 2, {
              swipes: ["Baseline fork", "ST choice one", "ST choice two"],
              swipe_id: text === "ST choice one" ? 1 : 2
            }),
            msg("Baseline reply", 3)
          ])
        yield* run([files[0]!, [files[1]![0], select("ST choice one")]])
        assert.strictEqual((yield* nameOf("ST choice one")).id, slot.id)
        const [aligned] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT row_version, st_import_row_version FROM slots WHERE id = ?", params: [slot.id] }],
          { readOnly: true }
        )
        assert.strictEqual(aligned![0]!.row_version, aligned![0]!.st_import_row_version)
        yield* api.NameBranch({ slotId: slot.id, name: "Local road" })
        yield* run([files[0]!, [files[1]![0], select("ST choice two")]])
        assert.strictEqual((yield* nameOf("ST choice one")).id, slot.id)
        assert.strictEqual((yield* nameOf("ST choice one")).name, "Local road")
        const [local] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT row_version, st_import_row_version FROM slots WHERE id = ?", params: [slot.id] }],
          { readOnly: true }
        )
        assert.isAbove(Number(local![0]!.row_version), Number(local![0]!.st_import_row_version))
      })
    )
  }
)
