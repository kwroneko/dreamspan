import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder, sendFile } from "./support/stUpload.ts"
import { stImportGraph } from "./support/stImportGraph.ts"

for (const count of [10, 205]) {
  const config = testConfig()

  layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
    `ST shared path selections: ${count} messages`,
    (it) => {
      it.effect("reimporting an ST branch with a changed shared-prefix swipe selects it only on the child's path", () =>
        Effect.gen(function* () {
          const main = Array.from({ length: count }, (_, i) =>
            message({
              name: i % 2 ? "Sam" : "Alice",
              user: !!(i % 2),
              mes: `parent ${i}`,
              minute: i,
              ...(!(i % 2) ? { swipes: [`parent ${i}`] } : {})
            })
          )
          const branch = main.map((m, i) =>
            i < 5 ? m : { ...m, mes: `branch ${i}`, ...(m.swipes ? { swipes: [`branch ${i}`] } : {}) }
          )
          const files = new Map([
            ["characters/Alice.png", card("Alice", "Synthetic greeting")],
            ["chats/Alice/main.jsonl", jsonl([header({}), ...main])],
            ["chats/Alice/branch.jsonl", jsonl([header({ main_chat: "main" }), ...branch])]
          ])
          const { api } = yield* importStFolder(files)
          const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === "main")!
          const root = (yield* stImportGraph(config.dataDir, chat.id))[0]!.id as SlotId
          const before = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: chat.activeLeafSlotId,
            range: { _tag: "Around", slot: root },
            limit: 100
          })
          const user = yield* api.Whoami()
          const sources = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats
          const childRecord = sources.find((r) => r.source === "chats/Alice/branch.jsonl")!
          const childBefore = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: childRecord.end,
            range: { _tag: "Around", slot: root },
            limit: 100
          })
          // A local suffix version and amendment must remain on the copied child path.
          const local = yield* api.EditVersion({
            sourceVersionId: childBefore.entries[8]!.version.id,
            slotId: childBefore.entries[8]!.slotId,
            content: "Local suffix version",
            expectedRowVersion: childBefore.entries[8]!.rowVersion
          })
          yield* api.AmendVersion({
            versionId: local.version.id,
            content: "Local suffix amended",
            expectedRowVersion: local.version.rowVersion
          })
          const writer = yield* Writer
          yield* writer.AddStateEvent({
            userId: user.id,
            chatId: chat.id,
            slotId: local.slotId,
            versionId: local.version.id,
            scope: null,
            data: { key: "var.set", value: { name: "fork-test", value: "branch only" } }
          })
          const graphBefore = yield* stImportGraph(config.dataDir, chat.id)
          const m = branch[4]!
          const at = "2025-01-02T10:04:00.000Z"
          branch[4] = {
            ...m,
            mes: "Only the ST branch chose this",
            send_date: at,
            swipe_id: 1,
            swipes: [...m.swipes!, "Only the ST branch chose this"],
            swipe_info: [...m.swipe_info!, { send_date: at, extra: {} }]
          }
          if (count > 100) {
            // Stop in the middle of the fork, then claim it in a new run from its start.
            // The old un-copied suffix must remain available beyond the partial new prior.
            const interrupted = yield* api.StartStImport({ unsupported: [] })
            const partial = yield* sendFile(
              interrupted.importId,
              "chats/Alice/branch.jsonl",
              jsonl([header({ main_chat: "main" }), ...branch.slice(0, 7)]),
              { part: "0", last: "0" }
            )
            assert.strictEqual(partial.status, 200)
          }
          const second = yield* importStFolder(
            new Map([
              ["characters/Alice.png", files.get("characters/Alice.png")!],
              ["chats/Alice/branch.jsonl", jsonl([header({ main_chat: "main" }), ...branch])]
            ])
          )
          const parentAfter = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: chat.activeLeafSlotId,
            range: { _tag: "Around", slot: root },
            limit: 100
          })
          const record = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats.find(
            (r) => r.source === "chats/Alice/branch.jsonl"
          )!
          const branchAfter = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: record.end,
            range: { _tag: "Around", slot: root },
            limit: 100
          })
          console.log(
            JSON.stringify({
              parentBefore: before.entries[4]!.version.content,
              parentAfter: parentAfter.entries[4]!.version.content,
              branchAfter: branchAfter.entries[4]!.version.content,
              report: second.report
            })
          )
          assert.strictEqual(parentAfter.entries[4]!.version.content, "parent 4")
          assert.strictEqual(branchAfter.entries[4]!.version.content, "Only the ST branch chose this")
          assert.strictEqual(branchAfter.entries[4]!.branchName, "branch")
          assert.isUndefined(branchAfter.entries[5]!.branchName)
          assert.strictEqual(branchAfter.entries[8]!.version.content, "Local suffix amended")
          const suffixVersions = yield* api.ListVersions({ slotId: branchAfter.entries[8]!.slotId })
          assert.deepStrictEqual(
            suffixVersions.map((v) => v.content),
            ["branch 8", "Local suffix amended"]
          )
          assert.strictEqual(suffixVersions[1]!.rowVersion, local.version.rowVersion + 1)
          assert.strictEqual(suffixVersions[1]!.sourceVersionId, suffixVersions[0]!.id)
          const [events] = yield* fixtureSql(
            config.dataDir,
            [
              {
                sql: "SELECT version_id AS version, key FROM state_events WHERE slot_id = ?",
                params: [branchAfter.entries[8]!.slotId]
              }
            ],
            { readOnly: true }
          )
          assert.deepStrictEqual(events, [{ version: suffixVersions[1]!.id, key: "var.set" }])
          const [history] = yield* fixtureSql(
            config.dataDir,
            [
              {
                sql: "SELECT content FROM version_history WHERE version_id = ? ORDER BY id",
                params: [suffixVersions[1]!.id]
              }
            ],
            { readOnly: true }
          )
          assert.deepStrictEqual(history, [{ content: "Local suffix version" }])
          assert.deepStrictEqual(
            branchAfter.entries.slice(0, 4).map((e) => e.slotId),
            childBefore.entries.slice(0, 4).map((e) => e.slotId)
          )
          assert.notStrictEqual(branchAfter.entries[4]!.slotId, childBefore.entries[4]!.slotId)
          const graphAfter = yield* stImportGraph(config.dataDir, chat.id)
          const shape = (rows: typeof graphBefore) => [
            ...new Map(rows.map((r) => [r.id, [r.id, r.parent, r.selected]])).values()
          ]
          assert.deepStrictEqual(
            shape(graphAfter.filter((r) => graphBefore.some((b) => b.id === r.id))),
            shape(graphBefore)
          )
          assert.strictEqual(new Set(graphAfter.map((r) => r.id)).size, 3 * count - 9)
          assert.isTrue(second.report.issues.some((i) => i.code === "st.differing"))
          assert.deepStrictEqual(
            parentAfter.entries.map((e) => e.slotId),
            before.entries.map((e) => e.slotId)
          )
          assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, chat.activeLeafSlotId)
          assert.deepStrictEqual(
            (yield* api.ListVersions({ slotId: branchAfter.entries[4]!.slotId })).map((v) => v.content),
            ["parent 4", "Only the ST branch chose this"]
          )
          const replay = yield* importStFolder(
            new Map([
              ["characters/Alice.png", files.get("characters/Alice.png")!],
              ["chats/Alice/branch.jsonl", jsonl([header({ main_chat: "main" }), ...branch])]
            ])
          )
          assert.strictEqual(replay.answers.get("chats/Alice/branch.jsonl")?.outcome, "unchanged")
          assert.isTrue(replay.report.issues.some((i) => i.code === "st.differing"))
          assert.deepStrictEqual(yield* stImportGraph(config.dataDir, chat.id), graphAfter)
          assert.deepStrictEqual(
            (yield* api.ReadPath({
              chatId: chat.id,
              leafSlotId: record.end,
              range: { _tag: "Around", slot: root },
              limit: 100
            })).entries,
            branchAfter.entries
          )
          main[4] = { ...main[4]!, mes: "Parent's later ST edit", swipes: ["Parent's later ST edit"] }
          const parentUpdate = yield* importStFolder(
            new Map([
              ["characters/Alice.png", files.get("characters/Alice.png")!],
              ["chats/Alice/main.jsonl", jsonl([header({}), ...main])]
            ])
          )
          assert.strictEqual(parentUpdate.answers.get("chats/Alice/main.jsonl")?.outcome, "updated")
          const parentEdited = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: chat.activeLeafSlotId,
            range: { _tag: "Around", slot: root },
            limit: 100
          })
          assert.strictEqual(parentEdited.entries[4]!.slotId, before.entries[4]!.slotId)
          assert.strictEqual(parentEdited.entries[4]!.version.content, "Parent's later ST edit")
          assert.strictEqual(
            new Set((yield* stImportGraph(config.dataDir, chat.id)).map((r) => r.id)).size,
            3 * count - 9
          )
          // A parent re-import that stopped after its first batch still owns its old end.
          const parentRecord = sources.find((r) => r.source === "chats/Alice/main.jsonl")!
          const interrupted = yield* api.StartStImport({ unsupported: [] })
          yield* writer.StImportClaim({ userId: user.id, recordId: parentRecord.recordId, lease: interrupted.importId })
          yield* writer.StImportMessages({
            userId: user.id,
            chatId: chat.id,
            recordId: parentRecord.recordId,
            lease: interrupted.importId,
            advanceLeaf: false,
            strict: false,
            parentSlotId: null,
            matching: true,
            speakers: {},
            messagesJson: JSON.stringify(
              main.slice(0, 2).map((m) => ({
                user: m.is_user,
                hidden: false,
                speaker: null,
                selected: 0,
                versions: [{ content: m.mes, reasoning: null, at: Date.parse(m.send_date) }]
              }))
            )
          })
          branch[4] = { ...branch[4]!, mes: "Another branch edit", swipes: ["parent 4", "Another branch edit"] }
          branch[6] = { ...branch[6]!, mes: "Exclusive child edit", swipes: ["Exclusive child edit"] }
          const changed = yield* importStFolder(
            new Map([
              ["characters/Alice.png", files.get("characters/Alice.png")!],
              ["chats/Alice/branch.jsonl", jsonl([header({ main_chat: "main", tainted: true }), ...branch])]
            ])
          )
          assert.strictEqual(changed.answers.get("chats/Alice/branch.jsonl")?.outcome, "updated")
          const parentStill = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: chat.activeLeafSlotId,
            range: { _tag: "Around", slot: root },
            limit: 100
          })
          assert.strictEqual(parentStill.entries[4]!.version.content, "Parent's later ST edit")
          assert.strictEqual(parentStill.entries[6]!.version.content, "parent 6")
          const childStill = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: record.end,
            range: { _tag: "Around", slot: root },
            limit: 100
          })
          assert.strictEqual(childStill.entries[4]!.version.content, "Another branch edit")
          assert.strictEqual(childStill.entries[6]!.version.content, "Exclusive child edit")
          assert.deepStrictEqual(
            childStill.entries.map((e) => e.slotId),
            branchAfter.entries.map((e) => e.slotId)
          )
        })
      )
    }
  )
}
