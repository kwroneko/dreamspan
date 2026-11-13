import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { HistoryEdit } from "@rp/shared/historyApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

const said = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })
const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id
  const writer = yield* Writer
  const reader = yield* Reader
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "Bulk history",
    participants: [],
    greeting: null
  })
  const forkId = chat.currentForkId!
  const entries = []
  let parent: SlotId | null = null
  for (let n = 0; n < 40; n++) {
    const entry: Effect.Success<ReturnType<typeof writer.AppendMessage>> = yield* writer.AppendMessage({
      userId,
      chatId: chat.id,
      forkId,
      parentSlotId: parent,
      branch: false,
      version: said(`Aria ${n}`),
      commitDraft: null
    })
    parent = entry.slotId
    entries.push(entry)
  }
  const edits: HistoryEdit[] = entries.map((e) => ({
    kind: "version_replace",
    targetId: e.version.id,
    beforeId: e.version.id,
    before: e.version.content,
    after: e.version.content.replace("Aria", "Ari")
  }))
  const path = (fork = forkId) =>
    reader.GetPath({ userId, chatId: chat.id, forkId: fork, leafSlotId: null, limit: 100 })
  return { api, userId, writer, reader, chat, forkId, entries, edits, path }
})

it.live("bulk copies preserve metadata, clear raw rewrites, keep swipe ordinals contiguous and undo together", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* setup
    yield* fixtureSql(config.dataDir, [
      {
        sql: "UPDATE version_records SET frozen_macros='{}',context_form='Frozen context',display_form='Frozen display',raw_content='Old raw' WHERE id=?",
        params: [f.entries[0]!.version.id]
      }
    ])
    const swipes = []
    for (let n = 0; n < 20; n++)
      swipes.push(
        yield* f.writer.AddVersion({
          userId: f.userId,
          slotId: f.entries[0]!.slotId,
          version: said(`Aria alternate ${n}`),
          select: false,
          commitDraft: null
        })
      )
    const edits = [
      ...f.edits,
      ...swipes.map((v) => ({
        kind: "version_replace" as const,
        targetId: v.id,
        beforeId: v.id,
        before: v.content,
        after: v.content.replace("Aria", "Ari")
      }))
    ]
    const applied = yield* f.writer.ApplyHistoryEdits({
      userId: f.userId,
      title: "Bulk",
      applications: [{ chatId: f.chat.id, forkId: f.forkId, edits }]
    })
    const [copies] = yield* fixtureSql(
      config.dataDir,
      [
        {
          sql: "SELECT ordinal,content,frozen_macros,context_form,display_form,raw_content FROM version_records WHERE changeset_id=? AND slot_id=? ORDER BY ordinal",
          params: [applied.changesetIds[0]!, f.entries[0]!.slotId]
        }
      ],
      { readOnly: true }
    )
    assert.deepStrictEqual(
      copies!.map((v) => v.ordinal),
      Array.from({ length: 21 }, (_, n) => 21 + n)
    )
    assert.strictEqual(copies![0]!.frozen_macros, "{}")
    assert.strictEqual(copies![0]!.context_form, "Frozen context")
    assert.strictEqual(copies![0]!.display_form, "Frozen display")
    assert.isNull(copies![0]!.raw_content)
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Ari ")))
    const undone = yield* f.writer.UndoHistoryEdit({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      changesetId: applied.changesetIds[0]!
    })
    assert.strictEqual(undone.undone, 60)
    assert.isEmpty(undone.conflicts)
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Aria ")))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("bulk groups share copies across forks and keep a branch made between applications frozen", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* setup
    const sibling = (yield* f.writer.CreateFork({
      userId: f.userId,
      chatId: f.chat.id,
      fromForkId: f.forkId,
      atSlotId: f.entries.at(-1)!.slotId
    })).fork
    const applied = yield* f.writer.ApplyHistoryEdits({
      userId: f.userId,
      title: "Both",
      applications: [f.forkId, sibling.id].map((forkId) => ({ chatId: f.chat.id, forkId, edits: f.edits }))
    })
    const first = yield* f.path()
    assert.deepStrictEqual(
      (yield* f.path(sibling.id)).entries.map((e) => e.version.id),
      first.entries.map((e) => e.version.id)
    )
    const child = (yield* f.writer.CreateFork({
      userId: f.userId,
      chatId: f.chat.id,
      fromForkId: f.forkId,
      atSlotId: f.entries.at(-1)!.slotId
    })).fork
    const edits: HistoryEdit[] = first.entries.map((e, n) => ({
      ...f.edits[n]!,
      beforeId: e.version.id,
      before: e.version.content,
      after: `Changed ${n}`
    }))
    const next = yield* f.writer.ApplyHistoryEdits({
      userId: f.userId,
      title: "Later",
      groupId: applied.groupId,
      applications: [{ chatId: f.chat.id, forkId: f.forkId, edits }]
    })
    assert.notStrictEqual(next.changesetIds[0], applied.changesetIds[0])
    assert.isTrue((yield* f.path(child.id)).entries.every((e) => e.version.content.startsWith("Ari ")))
    yield* f.writer.UndoHistoryEdit({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      changesetId: next.changesetIds[0]!
    })
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Ari ")))
    yield* f.writer.UndoHistoryEdit({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: child.id,
      changesetId: applied.changesetIds[0]!
    })
    assert.isTrue((yield* f.path(child.id)).entries.every((e) => e.version.content.startsWith("Aria ")))
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Ari ")))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("bulk validation refuses atomically and item Undo preserves later amendments", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* setup
    assert.strictEqual(
      yield* f.writer
        .ApplyHistoryEdits({
          userId: f.userId,
          title: "Stale tail",
          applications: [
            {
              chatId: f.chat.id,
              forkId: f.forkId,
              edits: f.edits.map((e, n) => (n === 39 ? { ...e, before: "Stale" } : e))
            }
          ]
        })
        .pipe(outcome),
      "HistoryRejected"
    )
    assert.isEmpty(yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }))
    assert.strictEqual(
      yield* f.writer
        .ApplyHistoryEdits({
          userId: f.userId,
          title: "Duplicate",
          applications: [{ chatId: f.chat.id, forkId: f.forkId, edits: [...f.edits, f.edits[0]!] }]
        })
        .pipe(outcome),
      "HistoryRejected"
    )
    const applied = yield* f.writer.ApplyHistoryEdits({
      userId: f.userId,
      title: "Valid",
      applications: [{ chatId: f.chat.id, forkId: f.forkId, edits: f.edits }]
    })
    const entry = (yield* f.path()).entries[0]!
    yield* f.writer.AmendVersion({
      userId: f.userId,
      forkId: f.forkId,
      versionId: entry.version.id,
      content: "Owner's later text",
      expectedRowVersion: entry.version.rowVersion
    })
    const undone = yield* f.writer.UndoHistoryEdit({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      changesetId: applied.changesetIds[0]!
    })
    assert.strictEqual(undone.undone, 39)
    assert.lengthOf(undone.conflicts, 1)
    assert.strictEqual((yield* f.path()).entries[0]!.version.content, "Owner's later text")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("bulk message and summary changes preserve their input proofs and restore freshness on Undo", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* setup
    const inputs = f.entries.map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
    const summary = yield* completeFixture(
      config.dataDir,
      f.writer,
      f.userId,
      f.chat.id,
      inputs,
      [],
      " Aria remembers."
    )
    const applied = yield* f.writer.ApplyHistoryEdits({
      userId: f.userId,
      title: "Messages and summary",
      applications: [
        {
          chatId: f.chat.id,
          forkId: f.forkId,
          summariesIncluded: true,
          edits: [
            ...f.edits,
            {
              kind: "summary_revision",
              targetId: summary.id,
              beforeId: summary.revisionId!,
              before: summary.content!,
              after: summary.content!.replaceAll("Aria", "Ari")
            }
          ]
        }
      ]
    })
    assert.isTrue((yield* f.reader.GetSummary({ userId: f.userId, forkId: f.forkId, summaryId: summary.id })).fresh)
    yield* f.writer.UndoHistoryEdit({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      changesetId: applied.changesetIds[0]!
    })
    const restored = yield* f.reader.GetSummary({ userId: f.userId, forkId: f.forkId, summaryId: summary.id })
    assert.isTrue(restored.fresh)
    assert.strictEqual(restored.content, summary.content)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("prepared rows stay invisible, bind exact input and owner, and publish only once", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* setup
    const first = yield* f.writer.PrepareHistoryEdits({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      total: 40,
      summariesIncluded: false,
      edits: f.edits.slice(0, 20)
    })
    assert.isEmpty(yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }))
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Aria ")))
    assert.strictEqual(
      yield* f.writer
        .PrepareHistoryEdits({
          userId: f.userId,
          chatId: f.chat.id,
          forkId: f.forkId,
          total: 40,
          summariesIncluded: false,
          token: first,
          edits: f.edits.slice(20).map((e, n) => (n === 19 ? { ...e, before: "Stale" } : e))
        })
        .pipe(outcome),
      "HistoryRejected"
    )
    const token = yield* f.writer.PrepareHistoryEdits({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      total: 40,
      summariesIncluded: false,
      token: first,
      edits: f.edits.slice(20)
    })
    const other = yield* f.writer.CreateUser({
      handle: "bulk-other",
      displayName: "Other",
      role: "user",
      passwordHash: "synthetic"
    })
    const payload = {
      userId: f.userId,
      title: "Prepared",
      prepared: token,
      applications: [{ chatId: f.chat.id, forkId: f.forkId, edits: f.edits }]
    }
    assert.strictEqual(
      yield* f.writer.ApplyHistoryEdits({ ...payload, userId: other.id }).pipe(outcome),
      "HistoryRejected"
    )
    assert.strictEqual(
      yield* f.writer
        .ApplyHistoryEdits({
          ...payload,
          applications: [
            {
              ...payload.applications[0]!,
              edits: f.edits.map((e, n) => (n === 0 ? { ...e, after: "Unapproved text" } : e))
            }
          ]
        })
        .pipe(outcome),
      "HistoryRejected"
    )
    assert.strictEqual(
      yield* f.writer
        .ApplyHistoryEdits({
          ...payload,
          applications: [
            {
              ...payload.applications[0]!,
              edits: [
                ...f.edits,
                {
                  kind: "summary_revision",
                  targetId: "missing-summary",
                  beforeId: "missing-revision",
                  before: "",
                  after: "Text"
                }
              ]
            }
          ]
        })
        .pipe(outcome),
      "NotFound"
    )
    assert.isEmpty(yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }))
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Aria ")))
    const applied = yield* f.writer.ApplyHistoryEdits(payload)
    assert.lengthOf(applied.changesetIds, 1)
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Ari ")))
    assert.strictEqual(yield* f.writer.ApplyHistoryEdits(payload).pipe(outcome), "HistoryRejected")
    yield* f.writer.UndoHistoryEdit({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      changesetId: applied.changesetIds[0]!
    })
    assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Aria ")))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("preparation refuses intervening changes and preserves copies across chunked swipes", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* setup
    const token = yield* f.writer.PrepareHistoryEdits({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      total: 40,
      summariesIncluded: false,
      edits: f.edits
    })
    yield* f.writer.AppendMessage({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      parentSlotId: f.entries.at(-1)!.slotId,
      branch: false,
      version: said("Owner appended"),
      commitDraft: null
    })
    assert.strictEqual(
      yield* f.writer
        .ApplyHistoryEdits({
          userId: f.userId,
          title: "Stale preparation",
          prepared: token,
          applications: [{ chatId: f.chat.id, forkId: f.forkId, edits: f.edits }]
        })
        .pipe(outcome),
      "HistoryRejected"
    )
    assert.isEmpty(yield* f.api.ListHistoryEdits({ chatId: f.chat.id, forkId: f.forkId }))
    const swipes = []
    for (let n = 0; n < 20; n++)
      swipes.push(
        yield* f.writer.AddVersion({
          userId: f.userId,
          slotId: f.entries[0]!.slotId,
          version: said(`Aria alternate ${n}`),
          select: false,
          commitDraft: null
        })
      )
    const edits: HistoryEdit[] = swipes.map((v) => ({
      kind: "version_replace",
      targetId: v.id,
      beforeId: v.id,
      before: v.content,
      after: v.content.replace("Aria", "Ari")
    }))
    const a = yield* f.writer.PrepareHistoryEdits({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      total: 20,
      summariesIncluded: false,
      edits: edits.slice(0, 10)
    })
    const b = yield* f.writer.PrepareHistoryEdits({
      userId: f.userId,
      chatId: f.chat.id,
      forkId: f.forkId,
      total: 20,
      summariesIncluded: false,
      token: a,
      edits: edits.slice(10)
    })
    const applied = yield* f.writer.ApplyHistoryEdits({
      userId: f.userId,
      title: "Swipes",
      prepared: b,
      applications: [{ chatId: f.chat.id, forkId: f.forkId, edits }]
    })
    const [rows] = yield* fixtureSql(
      config.dataDir,
      [
        {
          sql: "SELECT ordinal FROM versions WHERE changeset_id=? ORDER BY ordinal",
          params: [applied.changesetIds[0]!]
        }
      ],
      { readOnly: true }
    )
    assert.deepStrictEqual(
      rows!.map((r) => r.ordinal),
      Array.from({ length: 20 }, (_, n) => 21 + n)
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("scalar, bulk and staged rewrites record the writing fork and preserve only searched summary inputs", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* setup
    const summary = yield* completeFixture(
      config.dataDir,
      f.writer,
      f.userId,
      f.chat.id,
      f.entries.map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 })),
      [],
      "The garden."
    )
    for (const [count, staged, preserve] of [
      [1, false, false],
      [2, false, true],
      [40, true, false]
    ] as const) {
      const { fork } = yield* f.writer.CreateFork({
        userId: f.userId,
        chatId: f.chat.id,
        fromForkId: f.forkId,
        atSlotId: f.entries.at(-1)!.slotId
      })
      const edits = f.edits.slice(0, count)
      const summaryIds = preserve ? [summary.id] : []
      const application = { chatId: f.chat.id, forkId: fork.id, edits, summariesIncluded: true, summaryIds }
      let token: string | undefined
      if (staged) {
        for (let at = 0; at < count; at += 20) {
          token = yield* f.writer.PrepareHistoryEdits({
            userId: f.userId,
            chatId: f.chat.id,
            forkId: fork.id,
            total: count,
            summariesIncluded: true,
            summaryIds,
            ...(token ? { token } : {}),
            edits: edits.slice(at, at + 20)
          })
        }
        assert.strictEqual(
          yield* f.writer
            .ApplyHistoryEdits({
              userId: f.userId,
              title: "Changed scope",
              prepared: token!,
              applications: [{ ...application, summaryIds: [summary.id] }]
            })
            .pipe(outcome),
          "HistoryRejected"
        )
      }
      const applied = yield* f.writer.ApplyHistoryEdits({
        userId: f.userId,
        title: "Branch rewrite",
        ...(token ? { prepared: token } : {}),
        applications: [application]
      })
      const [copies] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT authoring_fork_id FROM versions WHERE changeset_id=?",
            params: [applied.changesetIds[0]!]
          }
        ],
        { readOnly: true }
      )
      assert.lengthOf(copies!, count)
      assert.isTrue(copies!.every((v) => v.authoring_fork_id === fork.id))
      assert.strictEqual(
        (yield* f.reader.GetSummary({ userId: f.userId, summaryId: summary.id, forkId: fork.id })).fresh,
        preserve
      )
      assert.isTrue((yield* f.path()).entries.every((e) => e.version.content.startsWith("Aria ")))
      yield* f.writer.UndoHistoryEdit({
        userId: f.userId,
        chatId: f.chat.id,
        forkId: fork.id,
        changesetId: applied.changesetIds[0]!
      })
      assert.isTrue((yield* f.reader.GetSummary({ userId: f.userId, summaryId: summary.id, forkId: fork.id })).fresh)
    }
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
