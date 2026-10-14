// Old messages changed in ST 1.19, using only synthetic JSONL through the real upload.
import { assert, layer } from "@effect/vitest"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { vi } from "vitest"
import { stImportGraph } from "./support/stImportGraph.ts"
import { posted, serverLayer, testConfig, typeInto } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

// The startup instance lock is the sole main-thread SQLite exception. Workers load
// their own modules, so this guard catches graph assertions that bypass them.
vi.mock("node:sqlite", async (original) => {
  const sqlite = await original<typeof import("node:sqlite")>()
  return {
    ...sqlite,
    DatabaseSync: new Proxy(sqlite.DatabaseSync, {
      construct(target, args) {
        if (!String(args[0]).endsWith("/instance.lock")) {
          throw new Error("SQLite graph assertions must run in a worker")
        }
        return Reflect.construct(target, args)
      }
    })
  }
})

const config = testConfig()
const graph = (chatId: ChatId) => stImportGraph(config.dataDir, chatId)

const lines = (tag: string, count = 10) =>
  Array.from({ length: count }, (_, i) =>
    message({
      name: i % 2 ? "Sam" : "Alice",
      user: i % 2 === 1,
      mes: `${tag} message ${i}`,
      minute: i,
      ...(!(i % 2) ? { swipes: [`${tag} message ${i}`] } : {})
    })
  )

// ST indexes messages from zero: message 4 here is the fifth message, a model reply.
// script.js saveReply/syncSwipeToMes: a generated swipe has a new date and extra,
// and selecting it copies those back to mes/send_date/extra.
const swipe = (m: ReturnType<typeof message>, text: string) => {
  const send_date = new Date(Date.UTC(2025, 0, 2, 10, 4)).toISOString()
  const extra = { reasoning: "Synthetic swipe reasoning.", api: "openai", model: "synthetic" }
  const gen_started = new Date(Date.UTC(2025, 0, 2, 10, 3)).toISOString()
  const gen_finished = send_date
  return {
    ...m,
    mes: text,
    send_date,
    gen_started,
    gen_finished,
    extra,
    swipe_id: m.swipes!.length,
    swipes: [...m.swipes!, text],
    swipe_info: [...m.swipe_info!, { send_date, gen_started, gen_finished, extra }]
  }
}

// script.js updateMessage/messageEditDone: overwrites mes and the selected swipe,
// sets extra.bias and tainted, but leaves send_date and swipe_info in place.
const edit = (m: ReturnType<typeof message>, text: string) => ({
  ...m,
  mes: text,
  swipes: m.swipes!.map((old, i) => (i === m.swipe_id ? text : old)),
  extra: { ...m.extra, bias: null }
})

const folder = (tag: string, messages: ReadonlyArray<unknown>, tainted = false) =>
  new Map([
    ["characters/Alice.png", card("Alice", "Synthetic greeting.")],
    [`chats/Alice/${tag}.jsonl`, jsonl([header({ tainted }), ...messages])]
  ])

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST old message changes", (it) => {
  for (const kind of ["swipe", "edit", "swipe-edit-append", "edit-local"] as const) {
    it.effect(`${kind}: preserves message 4 and its suffix, imports versions and keeps the right leaf`, () =>
      Effect.gen(function* () {
        const original = lines(kind)
        const first = yield* importStFolder(folder(kind, original))
        const { api } = first
        const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === kind)!
        const before = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        const fourth = before.entries[4]!
        const oldLeaf = chat.activeLeafSlotId!
        let expectedLeaf = oldLeaf
        if (kind === "edit-local") {
          const sent = yield* posted(
            api.SendMessage({ chatId: chat.id, parentSlotId: oldLeaf, branch: false, content: "Continued here" })
          )
          expectedLeaf = sent.entry.slotId
        }
        const draft = yield* typeInto(api, chat.id, expectedLeaf, "Keep this composer")
        const changed = lines(kind, kind === "swipe-edit-append" ? 12 : 10)
        if (kind === "swipe" || kind === "swipe-edit-append") changed[4] = swipe(original[4]!, `${kind} new swipe`)
        if (kind !== "swipe") changed[4] = edit(changed[4]!, `${kind} edited text`)
        const second = yield* importStFolder(folder(kind, changed, kind !== "swipe"), { partBytes: 1024 })
        const path = `chats/Alice/${kind}.jsonl`
        const after = yield* graph(chat.id)
        // Log all four observed outcomes before asserting, so the unfixed run is reviewable.
        const current = yield* api.GetChat({ chatId: chat.id })
        const oldPath = yield* api.ReadPath({
          chatId: chat.id,
          leafSlotId: oldLeaf,
          range: { _tag: "Bottom" },
          limit: 100
        })
        const activePath = yield* api.ReadPath({
          chatId: chat.id,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 100
        })
        console.log(
          JSON.stringify({
            case: kind,
            slots: new Set(after.map((r) => r.id)).size,
            message4Versions: (yield* api.ListVersions({ slotId: fourth.slotId })).map((v) => v.content),
            message4Selected: oldPath.entries[4]!.version.content,
            leaf: activePath.entries.at(-1)!.version.content,
            outcome: second.answers.get(path)?.outcome,
            counts: second.report.counts.chat,
            messages: second.report.messages,
            issues: second.report.issues
          })
        )
        assert.strictEqual(second.answers.get(path)?.outcome, "updated")
        assert.deepStrictEqual(
          { ...second.report.counts.chat },
          { added: 0, updated: 1, unchanged: 0, skipped: 0, failed: 0 }
        )
        assert.strictEqual(second.report.messages, changed.length)
        assert.isFalse(second.report.issues.some((i) => i.code === "st.differing"))
        const expectedCount = changed.length + (kind === "edit-local" ? 1 : 0)
        assert.strictEqual(new Set(after.map((r) => r.id)).size, expectedCount)
        for (const entry of before.entries) assert.isTrue(after.some((r) => r.id === entry.slotId))
        const versions = yield* api.ListVersions({ slotId: fourth.slotId })
        assert.deepStrictEqual(
          versions.map((v) => v.content),
          [original[4]!.mes, changed[4]!.mes]
        )
        const selected = yield* api.ReadPath({
          chatId: chat.id,
          leafSlotId: oldLeaf,
          range: { _tag: "Bottom" },
          limit: 100
        })
        assert.strictEqual(selected.entries[4]!.version.content, changed[4]!.mes)
        assert.deepStrictEqual(
          selected.entries.map((e) => e.slotId),
          before.entries.map((e) => e.slotId)
        )
        const imported = after.find((r) => r.id === fourth.slotId && r.content === changed[4]!.mes)!
        assert.deepStrictEqual(
          [imported.origin, imported.macroMode, imported.status, imported.at],
          ["imported", "verbatim", "complete", Date.parse(changed[4]!.send_date)]
        )
        assert.strictEqual(
          imported.reasoning,
          kind === "swipe" || kind === "swipe-edit-append" ? "Synthetic swipe reasoning." : null
        )
        if (kind === "swipe-edit-append") {
          const end = after.find((r) => r.content === changed[11]!.mes)!
          expectedLeaf = end.id as SlotId
          assert.strictEqual(after.find((r) => r.content === changed[10]!.mes)!.parent, oldLeaf)
          assert.strictEqual(end.parent, after.find((r) => r.content === changed[10]!.mes)!.id)
        }
        assert.strictEqual(current.activeLeafSlotId, expectedLeaf)
        const composer = yield* api.OpenComposer({ chatId: chat.id, tipSlotId: expectedLeaf })
        assert.strictEqual(composer.id, draft.id)
        assert.strictEqual(composer.content, draft.content)
        // Same changed file again: no extra version, slot, leaf or composer movement.
        const repeated = yield* importStFolder(folder(kind, changed, kind !== "swipe"), { partBytes: 1024 })
        assert.strictEqual(repeated.answers.get(path)?.outcome, "unchanged")
        assert.deepStrictEqual(yield* graph(chat.id), after)
        assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, expectedLeaf)
        assert.strictEqual((yield* api.OpenComposer({ chatId: chat.id, tipSlotId: expectedLeaf })).id, draft.id)
        // Another ST edit must still follow the import's own selection revision.
        changed[4] = edit(changed[4]!, `${kind} edited again`)
        const third = yield* importStFolder(folder(kind, changed, true))
        assert.strictEqual(third.answers.get(path)?.outcome, "updated")
        assert.strictEqual((yield* api.ListVersions({ slotId: fourth.slotId })).length, 3)
        assert.strictEqual(
          (yield* api.ReadPath({ chatId: chat.id, leafSlotId: oldLeaf, range: { _tag: "Bottom" }, limit: 100 }))
            .entries[4]!.version.content,
          changed[4]!.mes
        )
        assert.strictEqual(new Set((yield* graph(chat.id)).map((r) => r.id)).size, expectedCount)
      })
    )
  }

  for (const local of ["selection", "edit", "hide", "delete", "purge"] as const) {
    it.effect(`an ST edit of an old message preserves a local ${local}`, () =>
      Effect.gen(function* () {
        const tag = `local-${local}`
        const original = lines(tag)
        original[4] = {
          ...original[4]!,
          swipes: [original[4]!.mes, "Original alternate"],
          swipe_info: [original[4]!.swipe_info![0]!, original[4]!.swipe_info![0]!]
        }
        const { api } = yield* importStFolder(folder(tag, original))
        const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
        const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        const target = path.entries[4]!
        let expectedText = target.version.content
        if (local === "selection") {
          const alt = (yield* api.ListVersions({ slotId: target.slotId }))[1]!
          yield* api.SelectVersion({ slotId: target.slotId, versionId: alt.id, expectedRowVersion: target.rowVersion })
          expectedText = alt.content
        } else if (local === "edit") {
          yield* api.WriteVersion({
            slotId: target.slotId,
            content: "Local edited text",
            expectedRowVersion: target.rowVersion
          })
          expectedText = "Local edited text"
        } else if (local === "hide") {
          yield* api.SetMessageHidden({ slotId: target.slotId, hidden: true })
        } else {
          const item = yield* api.DeleteMessage({ slotId: target.slotId })
          if (local === "purge") yield* api.PurgeBinItem({ itemId: item.id })
        }
        original[4] = edit(original[4]!, "ST edited text")
        const second = yield* importStFolder(folder(tag, original, true), { partBytes: 1024 })
        assert.strictEqual(new Set((yield* graph(chat.id)).map((r) => r.id)).size, 10)
        const after = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
        assert.strictEqual((yield* api.GetChat({ chatId: chat.id })).activeLeafSlotId, chat.activeLeafSlotId)
        if (local === "delete" || local === "purge") {
          assert.isFalse(after.entries.some((e) => e.slotId === target.slotId))
          if (local === "purge") {
            assert.isFalse((yield* graph(chat.id)).some((r) => r.content === "ST edited text"))
            assert.strictEqual(second.answers.get(`chats/Alice/${tag}.jsonl`)?.outcome, "unchanged")
          }
        } else {
          assert.strictEqual(after.entries[4]!.version.content, expectedText)
          assert.strictEqual(after.entries[4]!.contextExcluded, local === "hide")
        }
        if (local !== "purge") {
          assert.isTrue((yield* graph(chat.id)).some((r) => r.id === target.slotId && r.content === "ST edited text"))
          assert.isTrue(second.report.issues.some((i) => i.code === "st.differing"))
          assert.strictEqual(second.answers.get(`chats/Alice/${tag}.jsonl`)?.outcome, "updated")
        }
      })
    )
  }

  it.effect("the recorded slot wins when ST's edited text already exists on a sibling branch", () =>
    Effect.gen(function* () {
      const tag = "sibling"
      const original = lines(tag)
      const files = folder(tag, original)
      const branch = lines(tag)
      branch[4] = edit(branch[4]!, "Branch text")
      files.set("chats/Alice/sibling-branch.jsonl", jsonl([header({ main_chat: tag, tainted: true }), ...branch]))
      const { api } = yield* importStFolder(files)
      const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === tag)!
      const before = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      const target = before.entries[4]!.slotId
      original[4] = edit(original[4]!, "Branch text")
      yield* importStFolder(folder(tag, original, true), { partBytes: 1024 })
      const after = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      assert.strictEqual(new Set((yield* graph(chat.id)).map((r) => r.id)).size, 16)
      assert.deepStrictEqual(
        after.entries.map((e) => e.slotId),
        before.entries.map((e) => e.slotId)
      )
      assert.strictEqual(after.entries[4]!.version.content, "Branch text")
      assert.deepStrictEqual(
        (yield* api.ListVersions({ slotId: target })).map((v) => v.content),
        ["sibling message 4", "Branch text"]
      )
    })
  )
})
