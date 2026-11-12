import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { ApprovalPrompt } from "@rp/shared/agent.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { makePermit } from "../src/agent/approvals.ts"
import { client, serverLayer, testConfig, outcome } from "./support/config.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"
import { eventually } from "./support/generation.ts"
import { newChatNote } from "@rp/shared/editing.ts"

const said = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })
const fixture = (dataDir: string) =>
  Effect.gen(function* () {
    const api = yield* client()
    const userId = (yield* api.Whoami()).id
    const writer = yield* Writer
    const reader = yield* Reader
    const registry = yield* ExecutionRegistry
    const workshop = yield* api.CreateWorkshop({ title: "Setup" })
    const rolloutId = `rewrite-${workshop.id}`
    yield* fixtureSql(dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, workshop.id]
      },
      { sql: "UPDATE versions SET rollout_id=? WHERE slot_id=?", params: [rolloutId, workshop.activeLeafSlotId] }
    ])
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "The garden",
      participants: [],
      greeting: null
    })
    const forkId = chat.currentForkId!
    const entries = []
    let parent: SlotId | null = null
    for (let n = 0; n < 10; n++) {
      const posted: Effect.Success<ReturnType<typeof writer.AppendMessage>> = yield* writer.AppendMessage({
        userId,
        chatId: chat.id,
        forkId,
        parentSlotId: parent,
        branch: false,
        version: said(`Aria meets the gardener ${n}.`),
        commitDraft: null
      })
      entries.push(posted)
      parent = posted.slotId
    }
    const context: ToolContext = {
      userId,
      chatId: workshop.id,
      forkId: workshop.currentForkId,
      slotId: workshop.activeLeafSlotId!,
      versionId: "unused" as VersionId,
      rolloutId,
      toolCallId: "unused",
      leafSlotId: workshop.activeLeafSlotId,
      reader,
      writer,
      cache: new Map()
    }
    const tool = (name: string) => toolForKind(registry, "workshop", name)!
    const run = (name: string, args: unknown, id = name) =>
      tool(name).execute({ ...context, toolCallId: id }, args as never)
    const path = () => reader.GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 100 })
    return {
      api,
      userId,
      writer,
      reader,
      registry,
      workshop,
      rolloutId,
      chat,
      forkId,
      entries,
      context,
      tool,
      run,
      path
    }
  })
const pairs = [{ find: "Aria", replace: "Ari", in: ["messages", "summaries"] }]

describe("workshop chat rewrites", () => {
  it.live(
    "renames messages and dependent summaries once, preserves forks and swipes, and undoes the whole changeset",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const f = yield* fixture(config.dataDir)
        const sibling = (yield* f.writer.CreateFork({
          userId: f.userId,
          chatId: f.chat.id,
          fromForkId: f.forkId,
          atSlotId: f.entries.at(-1)!.slotId
        })).fork
        const swipe = yield* f.writer.AddVersion({
          userId: f.userId,
          slotId: f.entries[0]!.slotId,
          version: said("Aria unshown swipe"),
          select: false,
          commitDraft: null
        })
        const inputs = (yield* f.path()).entries.map((e) => ({
          slotId: e.slotId,
          versionId: e.version.id,
          amendCount: 0
        }))
        const summary = yield* completeFixture(
          config.dataDir,
          f.writer,
          f.userId,
          f.chat.id,
          inputs,
          [],
          " Aria remembers the garden."
        )
        yield* fixtureSql(config.dataDir, [
          {
            sql: "UPDATE chats SET current_fork_id=?, active_leaf_slot_id=? WHERE id=?",
            params: [f.forkId, f.entries.at(-1)!.slotId, f.chat.id]
          }
        ])
        const result = yield* f.run("rewrite_chat", { chat: f.chat.id, title: "Rename Aria", pairs })
        assert.isUndefined(result.isError, result.text)
        assert.strictEqual(JSON.parse(result.text).messages, 10)
        assert.strictEqual(JSON.parse(result.text).summaries, 1)
        assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Ari ")))
        assert.strictEqual(
          (yield* f.reader.GetSummary({ userId: f.userId, forkId: f.forkId, summaryId: summary.id })).content!.endsWith(
            "Ari remembers the garden."
          ),
          true
        )
        assert.isTrue(
          (yield* f.reader.GetPath({
            userId: f.userId,
            chatId: f.chat.id,
            forkId: sibling.id,
            leafSlotId: null,
            limit: 100
          })).entries.every((e) => e.version.content.startsWith("Aria "))
        )
        assert.strictEqual(
          (yield* f.reader.GetVersion({ userId: f.userId, versionId: swipe.id })).content,
          "Aria unshown swipe"
        )
        const records = yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId })
        assert.lengthOf(records, 1)
        assert.strictEqual(records[0]!.workshop!.name, "Setup")
        assert.isNotNull(records[0]!.workshop!.slotId)
        assert.strictEqual(
          (yield* f.api.ListActivity({ chatId: f.chat.id, limit: 20 })).rows.find((row) => row.kind === "edit")!.kind,
          "edit"
        )
        assert.deepStrictEqual(yield* f.run("rewrite_chat", { chat: "missing", title: "Replay", pairs }), result)
        const effect = (yield* f.api.ListRolloutEffects({ chatId: f.workshop.id }))[0]!
        yield* f.api.UndoRolloutEffect(effect)
        assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Aria ")))
        assert.strictEqual(
          (yield* f.reader.GetSummary({ userId: f.userId, forkId: f.forkId, summaryId: summary.id })).content,
          summary.content
        )
        const [ledger] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT count(*) AS n FROM llm_requests WHERE rollout_id IN (SELECT id FROM rollouts WHERE chat_id=?)",
              params: [f.chat.id]
            }
          ],
          { readOnly: true }
        )
        assert.strictEqual(ledger![0]!.n, 0)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )
  it.live("writes ten messages, permits an individual undo, and keeps the other nine applied", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const result = yield* f.run("rewrite_messages", {
        chat: f.chat.id,
        title: "Past tense",
        messages: Array.from({ length: 10 }, (_, i) => ({ message: i + 1, text: `Aria met the gardener ${i}.` }))
      })
      assert.isUndefined(result.isError, result.text)
      const record = (yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }))[0]!
      assert.lengthOf(record.items, 10)
      yield* f.api.UndoHistoryEdit({
        chatId: f.chat.id,
        forkId: f.forkId,
        changesetId: record.id,
        itemIds: [record.items[0]!.id]
      })
      const path = yield* f.path()
      assert.strictEqual(path.entries.filter((e) => e.version.content.includes("met")).length, 9)
      assert.strictEqual(
        (yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }))[0]!.status,
        "partly undone"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("refuses live generation, stale previews, unshown targets and changes without current permission", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const args = { chat: f.chat.id, title: "Rename", pairs }
      const context = { ...f.context, toolCallId: "stale" }
      const prompt = yield* f.tool("rewrite_chat").describe!(context, args as never)
      assert.strictEqual(prompt.title, "Rewrite “The garden”")
      assert.include(prompt.rows[0]!.value, "10 messages")
      assert.strictEqual(prompt.changes![0]!.before, "Aria meets the gardener 0.")
      yield* f.writer.AppendMessage({
        userId: f.userId,
        chatId: f.chat.id,
        forkId: f.forkId,
        parentSlotId: f.entries.at(-1)!.slotId,
        branch: false,
        version: said("User appended"),
        commitDraft: null
      })
      assert.isTrue((yield* f.tool("rewrite_chat").execute(context, args as never)).isError)
      const writing = yield* f.writer.AppendMessage({
        userId: f.userId,
        chatId: f.chat.id,
        forkId: f.forkId,
        parentSlotId: (yield* f.path()).tipSlotId,
        branch: false,
        version: new NewVersion({ ...said(""), status: "generating", writer: "model" }),
        commitDraft: null
      })
      const busy = yield* f.run("rewrite_chat", args, "busy")
      assert.isTrue(busy.isError)
      assert.include(busy.text, "writing a reply")
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE versions SET status='stopped' WHERE slot_id=?", params: [writing.slotId] }
      ])
      yield* f.writer.SetWorkshopGrant({
        userId: f.userId,
        chatId: f.workshop.id,
        capability: "chats.rewrite",
        mode: "off"
      })
      assert.isTrue((yield* f.run("rewrite_chat", args, "off")).isError)
      yield* f.writer.SetWorkshopGrant({
        userId: f.userId,
        chatId: f.workshop.id,
        capability: "chats.rewrite",
        mode: "ask"
      })
      assert.isTrue((yield* f.run("rewrite_chat", args, "unapproved")).isError)
      assert.lengthOf(yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }), 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("asks separately for chat reading, pages the whole visible chat and treats its text as untrusted", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      assert.isTrue((yield* f.run("read_chat", { chat: f.chat.id })).isError)
      let waiting: ApprovalPrompt | null = null
      const context = { ...f.context, toolCallId: "read-approved" }
      const tool = f.tool("read_chat")
      const permission = yield* makePermit({
        registries: f.registry,
        reader: f.reader,
        writer: f.writer,
        userId: f.userId,
        chatId: f.workshop.id,
        rolloutId: f.rolloutId
      })({
        tool,
        context,
        args: { chat: f.chat.id, count: 3 },
        dangling: false,
        onWaiting: (p) => {
          waiting = p
        }
      }).pipe(Effect.forkScoped)
      yield* eventually(() => waiting !== null)
      assert.include(waiting!.rows[0]!.value, "separate character contexts")
      yield* f.api.AnswerToolApproval({ ...waiting!, answer: "allow" })
      const permit = yield* Fiber.join(permission)
      assert.isTrue(permit.run)
      if (!permit.run) throw new Error("not permitted")
      const result = yield* tool.execute(
        { ...context, ...(permit.approvalDigest ? { approvalDigest: permit.approvalDigest } : {}) },
        { chat: f.chat.id, count: 3 } as never
      )
      assert.isUndefined(result.isError, result.text)
      const page = JSON.parse(result.text)
      assert.lengthOf(page.messages, 3)
      assert.strictEqual(page.next, 4)
      assert.include(page.notice, "Untrusted")
      yield* f.writer.SetWorkshopGrant({
        userId: f.userId,
        chatId: f.workshop.id,
        capability: "chats.read",
        mode: "allow"
      })
      const search = JSON.parse((yield* f.run("search_chats", { chat: f.chat.id, query: "gardener 7", count: 3 })).text)
      assert.strictEqual(search.messages[0].message, 8)
      yield* f.writer.SetWorkshopGrant({
        userId: f.userId,
        chatId: f.workshop.id,
        capability: "chats.read",
        mode: "off"
      })
      assert.isTrue((yield* f.run("search_chats", { chat: f.chat.id, query: "Aria" }, "read-off")).isError)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("combines note text, preset and lorebook changes and restores their state in one Undo", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const note = yield* f.writer.CreateEntity({
        userId: f.userId,
        kind: "note",
        label: "Direction",
        subtitle: "",
        schemaVersion: 1,
        origin: "user",
        sourcePath: null,
        doc: { ...newChatNote(f.chat.id, "Direction"), content: "Original direction" }
      })
      const preset = yield* f.api.CreatePreset({ label: "New direction preset" })
      const book = yield* f.api.CreateLorebook({ label: "New direction lore" })
      const result = yield* f.run("rewrite_instructions", {
        chat: f.chat.id,
        title: "New instructions",
        changes: [
          { note: note.entityId, text: "New direction" },
          { preset: preset.id },
          { lorebook: book.id, on: true }
        ]
      })
      assert.isUndefined(result.isError, result.text)
      const record = (yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }))[0]!
      assert.lengthOf(record.items, 3)
      const notes = yield* f.reader.ChatNoteEntries({
        userId: f.userId,
        chatId: f.chat.id,
        forkId: f.forkId,
        slotId: f.entries.at(-1)!.slotId,
        cards: []
      })
      assert.strictEqual(notes[0]!.doc.content, "New direction")
      yield* f.api.UndoHistoryEdit({ chatId: f.chat.id, forkId: f.forkId, changesetId: record.id })
      assert.strictEqual(
        (yield* f.reader.ChatNoteEntries({
          userId: f.userId,
          chatId: f.chat.id,
          forkId: f.forkId,
          slotId: f.entries.at(-1)!.slotId,
          cards: []
        }))[0]!.doc.content,
        "Original direction"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("bounds new text and rejects other owners and arbitrary state keys", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const oversized = yield* f.run("rewrite_messages", {
        chat: f.chat.id,
        title: "Too much",
        messages: [{ message: 1, text: "x".repeat(65537) }]
      })
      assert.isTrue(oversized.isError)
      const expected = (yield* f.reader.AgentHistorySnapshot({ userId: f.userId, chatId: f.chat.id, forkId: f.forkId }))
        .stamp
      const result = yield* f.writer
        .ApplyAgentChangeset({
          userId: f.userId,
          rolloutId: f.rolloutId,
          toolCallId: "forbidden-state",
          chatId: f.chat.id,
          forkId: f.forkId,
          expected,
          title: "Permission",
          includeSwipes: false,
          summariesIncluded: false,
          edits: [
            {
              kind: "state_event",
              targetId: "",
              beforeId: "",
              before: "",
              after: JSON.stringify({
                scope: null,
                data: { key: "agent.permission", value: { target: { note: "no" }, on: true } }
              })
            }
          ]
        })
        .pipe(outcome)
      assert.strictEqual(result, "HistoryRejected")
      const other = yield* f.writer.CreateUser({
        handle: "other-reader",
        displayName: "Other",
        role: "user",
        passwordHash: "synthetic-not-used"
      })
      assert.strictEqual(
        yield* f.reader.AgentHistorySnapshot({ userId: other.id, chatId: f.chat.id, forkId: f.forkId }).pipe(outcome),
        "NotFound"
      )
      assert.strictEqual(
        yield* f.reader
          .AgentRewriteTargets({ userId: other.id, chatId: f.chat.id, forkId: f.forkId, messages: [1] })
          .pipe(outcome),
        "NotFound"
      )
      assert.strictEqual(
        yield* f.writer
          .StartEditRollout({
            userId: other.id,
            rolloutId: f.rolloutId,
            toolCallId: "other",
            chatId: f.chat.id,
            forkId: f.forkId
          })
          .pipe(outcome),
        "NotFound"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("bounds total written text per run and keeps Undo from replenishing it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      for (let call = 0; call < 4; call++) {
        const result = yield* f.run(
          "rewrite_messages",
          {
            chat: f.chat.id,
            title: "Bounded text",
            messages: Array.from({ length: 4 }, (_, i) => ({ message: i + 1, text: String(call).repeat(65536) }))
          },
          `budget-${call}`
        )
        assert.isUndefined(result.isError, result.text)
      }
      const effects = yield* f.api.ListRolloutEffects({ chatId: f.workshop.id })
      yield* f.api.UndoRolloutEffect(effects[0]!)
      const result = yield* f.run(
        "rewrite_messages",
        { chat: f.chat.id, title: "Over run limit", messages: [{ message: 1, text: "A little more" }] },
        "too-many-bytes"
      )
      assert.isTrue(result.isError)
      assert.include(result.text, "rewrite limit")
      assert.lengthOf(yield* f.api.ListRolloutEffects({ chatId: f.workshop.id }), 4)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("enforces ownership for reads, edits, summaries and provenance in the target chat", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const other = yield* f.writer.CreateUser({
        handle: "isolated-owner",
        displayName: "Isolated",
        role: "user",
        passwordHash: "unused-synthetic"
      })
      const workshop = yield* f.writer.CreateWorkshop({ userId: other.id })
      const rolloutId = `other-${workshop.id}`
      yield* fixtureSql(config.dataDir, [
        {
          sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
          params: [rolloutId, workshop.id]
        }
      ])
      yield* f.writer.SetWorkshopGrant({
        userId: other.id,
        chatId: workshop.id,
        capability: "chats.read",
        mode: "allow"
      })
      const key = { userId: other.id, rolloutId, toolCallId: "other-read", chatId: f.chat.id, forkId: f.forkId }
      assert.strictEqual(yield* f.reader.ReadWorkshopChat({ ...key, from: 1, count: 5 }).pipe(outcome), "NotFound")
      assert.strictEqual(yield* f.writer.StartEditRollout(key).pipe(outcome), "NotFound")
      const expected = (yield* f.reader.AgentHistorySnapshot({ userId: f.userId, chatId: f.chat.id, forkId: f.forkId }))
        .stamp
      assert.strictEqual(
        yield* f.writer
          .ApplyAgentChangeset({
            ...key,
            expected,
            title: "Foreign rewrite",
            includeSwipes: false,
            summariesIncluded: false,
            edits: [
              {
                kind: "version_replace",
                targetId: f.entries[0]!.version.id,
                beforeId: f.entries[0]!.version.id,
                before: "Aria meets the gardener 0.",
                after: "Foreign"
              }
            ]
          })
          .pipe(outcome),
        "NotFound"
      )
      assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Aria ")))
      const swipe = yield* f.writer.AddVersion({
        userId: f.userId,
        slotId: f.entries[0]!.slotId,
        version: said("Private swipe"),
        select: false,
        commitDraft: null
      })
      const proof = yield* f.reader.AgentHistorySnapshot({ userId: f.userId, chatId: f.chat.id, forkId: f.forkId })
      const unshown = yield* f.writer
        .ApplyAgentChangeset({
          userId: f.userId,
          rolloutId: f.rolloutId,
          toolCallId: "unshown",
          chatId: f.chat.id,
          forkId: f.forkId,
          expected: proof.stamp,
          title: "Unshown",
          includeSwipes: false,
          summariesIncluded: false,
          edits: [
            { kind: "version_replace", targetId: swipe.id, beforeId: swipe.id, before: "Private swipe", after: "No" }
          ]
        })
        .pipe(outcome)
      assert.strictEqual(unshown, "HistoryRejected")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("pages a long message without losing its tail and searches beyond the excerpt", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const content = "x".repeat(13000) + " find_tail"
      yield* f.writer.AppendMessage({
        userId: f.userId,
        chatId: f.chat.id,
        forkId: f.forkId,
        parentSlotId: f.entries.at(-1)!.slotId,
        branch: false,
        version: said(content),
        commitDraft: null
      })
      yield* f.writer.SetWorkshopGrant({
        userId: f.userId,
        chatId: f.workshop.id,
        capability: "chats.read",
        mode: "allow"
      })
      const first = JSON.parse((yield* f.run("read_chat", { chat: f.chat.id, from: 11, count: 1 })).text)
      assert.strictEqual(first.next, 11)
      assert.strictEqual(first.nextOffset, 6000)
      const second = JSON.parse(
        (yield* f.run(
          "read_chat",
          { chat: f.chat.id, from: first.next, offset: first.nextOffset, count: 1 },
          "long-second"
        )).text
      )
      const third = JSON.parse(
        (yield* f.run(
          "read_chat",
          { chat: f.chat.id, from: second.next, offset: second.nextOffset, count: 1 },
          "long-third"
        )).text
      )
      assert.strictEqual(first.messages[0].text + second.messages[0].text + third.messages[0].text, content)
      const search = JSON.parse(
        (yield* f.run("search_chats", { chat: f.chat.id, query: "find_tail" }, "long-search")).text
      )
      assert.strictEqual(search.messages[0].message, 11)
      assert.include(search.messages[0].text, "find_tail")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
  it.live("uses the panel's original-text overlap rules across several pairs", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const initial = yield* f.run("rewrite_messages", {
        chat: f.chat.id,
        title: "Overlap fixture",
        messages: [{ message: 1, text: "abc" }]
      })
      assert.isUndefined(initial.isError, initial.text)
      const result = yield* f.run(
        "rewrite_chat",
        {
          chat: f.chat.id,
          title: "Overlapping replacements",
          pairs: [
            { find: "bc", replace: "x", in: ["messages"] },
            { find: "c", replace: "Y", in: ["messages"] },
            { find: "ab", replace: "Q", in: ["messages"] }
          ]
        },
        "overlap"
      )
      assert.isUndefined(result.isError, result.text)
      assert.strictEqual((yield* f.path()).entries[0]!.version.content, "QY")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
