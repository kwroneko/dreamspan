import { assert, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { AppendResult } from "../src/db/ops.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture, fixtureSql, summaryJob } from "./support/lcmFixtures.ts"

const config = testConfig()
it.live(
  "summary writes and recursive freshness over branches, amendments, swipes, hides, deletes and restores",
  () =>
    Effect.gen(function* () {
      const api = yield* client(),
        user = yield* api.Whoami(),
        writer = yield* Writer,
        reader = yield* Reader
      const chat = yield* writer.CreateChat({
        userId: user.id,
        kind: "rp",
        status: "active",
        title: "Synthetic",
        participants: [],
        greeting: null
      })
      const version = (content: string) =>
        new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      const a = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        version: version("a"),
        commitDraft: null
      })
      const b = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: a.slotId,
        branch: false,
        version: version("b"),
        commitDraft: null
      })
      const input = (entry: typeof a) => ({ slotId: entry.slotId, versionId: entry.version.id, amendCount: 0 })
      const l1 = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [input(a), input(b)])
      const l2 = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [l1])
      const fresh = (expected: boolean) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* api.GetSummary({ summaryId: l1.id })).fresh, expected)
          assert.strictEqual((yield* reader.GetSummary({ userId: user.id, summaryId: l2.id })).fresh, expected)
        })
      yield* fresh(true)
      yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: a.slotId,
        branch: true,
        version: version("other branch"),
        commitDraft: null
      })
      yield* fresh(true)
      const swipe = yield* writer.AddVersion({
        userId: user.id,
        slotId: a.slotId,
        version: version("swipe"),
        select: true,
        commitDraft: null
      })
      yield* fresh(false)
      yield* writer.SelectVersion({
        userId: user.id,
        slotId: a.slotId,
        versionId: a.version.id,
        expectedVersionId: swipe.id
      })
      yield* fresh(true)
      const bin = yield* writer.DeleteMessage({ userId: user.id, slotId: b.slotId })
      yield* fresh(false)
      const absent = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [
        input(a),
        { slotId: b.slotId, versionId: null, amendCount: 0 }
      ])
      assert.isTrue(absent.fresh)
      yield* writer.RestoreBinItem({ userId: user.id, itemId: bin.id })
      yield* fresh(true)
      assert.isFalse((yield* api.GetSummary({ summaryId: absent.id })).fresh)
      yield* writer.SetSlotHidden({ userId: user.id, slotId: a.slotId, hidden: true })
      yield* fresh(false)
      yield* writer.SetSlotHidden({ userId: user.id, slotId: a.slotId, hidden: false })
      yield* fresh(true)
      const key = { targetKind: "summary_edit" as const, targetId: l1.id, field: "" }
      const draft = yield* writer.SaveDraft({
        userId: user.id,
        key,
        draftId: null,
        content: "{{summary}} literal",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevision: l1.revisionId
      })
      const edited = yield* api.EditSummary({
        summaryId: l1.id,
        content: "{{summary}} literal",
        expectedRowVersion: 1,
        commitDraft: { draftId: draft.id, session: draft.session }
      })
      assert.strictEqual(edited.summary.origin, "user")
      const storedDraft = yield* reader.GetDraft({ userId: user.id, key })
      assert.strictEqual(storedDraft?.status, "committed")
      assert.isFalse((yield* api.GetSummary({ summaryId: l2.id })).fresh)
      assert.strictEqual(
        yield* outcome(
          api.EditSummary({ summaryId: l1.id, content: "stale", expectedRowVersion: 1, commitDraft: null }),
          () => "allowed"
        ),
        "StaleWrite"
      )
      yield* api.SelectSummaryRevision({ summaryId: l1.id, revisionId: l1.revisionId, expectedRowVersion: 2 })
      yield* fresh(true)
      assert.strictEqual(
        yield* outcome(
          api.SelectSummaryRevision({ summaryId: l1.id, revisionId: l2.revisionId, expectedRowVersion: 3 }),
          () => "allowed"
        ),
        "NotFound"
      )
      // The other branch's fork, current now, shows it too: the amend gives that fork a copy.
      const amended = yield* writer.AmendVersion({
        userId: user.id,
        versionId: a.version.id,
        content: "amended",
        expectedRowVersion: 1
      })
      const amendedInput = { slotId: a.slotId, versionId: amended.id, amendCount: 1 }
      yield* fresh(false)
      const updated = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [amendedInput, input(b)])
      assert.isTrue(updated.fresh)
      const job = yield* summaryJob(config.dataDir, chat.id, a.slotId, b.slotId)
      const counts = () =>
        fixtureSql(config.dataDir, [
          {
            sql: "SELECT (SELECT count(*) FROM summaries) AS summaries, (SELECT count(*) FROM summary_revisions) AS revisions"
          }
        ])
      const before = yield* counts()
      assert.strictEqual(
        yield* outcome(
          writer.CompleteSummary({
            userId: user.id,
            ...job,
            content: "wrong order",
            status: "complete",
            inputs: [input(b), input(a)],
            children: []
          }),
          () => "allowed"
        ),
        "StorageError:constraint"
      )
      assert.deepStrictEqual(yield* counts(), before)
      yield* fixtureSql(config.dataDir, [
        {
          sql: `CREATE TRIGGER summary_completion_abort BEFORE UPDATE ON rollouts WHEN NEW.id = '${job.rolloutId}' BEGIN SELECT RAISE(ABORT, 'planted late failure'); END`
        }
      ])
      assert.strictEqual(
        yield* outcome(
          writer.CompleteSummary({
            userId: user.id,
            ...job,
            content: "Fails after inserts",
            status: "complete",
            inputs: [amendedInput, input(b)],
            children: []
          }),
          () => "allowed"
        ),
        "StorageError:constraint"
      )
      assert.deepStrictEqual(yield* counts(), before)
      const [states, rolloutState] = yield* fixtureSql(config.dataDir, [
        { sql: "SELECT status FROM summarization_jobs WHERE id=?", params: [job.jobId] },
        { sql: "SELECT status FROM rollouts WHERE id=?", params: [job.rolloutId] },
        { sql: "DROP TRIGGER summary_completion_abort" }
      ])
      assert.strictEqual(states![0]!.status, "processing")
      assert.strictEqual(rolloutState![0]!.status, "running")

      const deleted = yield* writer.DeleteVersion({ userId: user.id, versionId: swipe.id })
      yield* writer.PurgeBinItem({ userId: user.id, itemId: deleted.id })
      assert.strictEqual((yield* api.GetSummary({ summaryId: l1.id })).content, l1.content)
    }).pipe(Effect.provide(serverLayer(config))),
  { timeout: 60_000 }
)

for (const side of ["left", "right"] as const)
  it.live(
    `absorption ${side} of an existing parent derives supersessions atomically`,
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client(),
          user = yield* api.Whoami(),
          writer = yield* Writer
        const chat = yield* writer.CreateChat({
          userId: user.id,
          kind: "rp",
          status: "active",
          title: "Absorption",
          participants: [],
          greeting: null
        })
        const leaves = []
        let tip: SlotId | null = null
        for (const content of ["a", "b", "c"]) {
          const entry: AppendResult = yield* writer.AppendMessage({
            userId: user.id,
            chatId: chat.id,
            parentSlotId: tip,
            branch: false,
            version: new NewVersion({
              speakerEntityId: null,
              writer: "human",
              content,
              status: "complete",
              macroMode: "verbatim",
              origin: "user_written"
            }),
            commitDraft: null
          })
          tip = entry.slotId
          leaves.push(
            yield* completeFixture(config.dataDir, writer, user.id, chat.id, [
              { slotId: entry.slotId, versionId: entry.version.id, amendCount: 0 }
            ])
          )
        }
        const originals = side === "left" ? leaves.slice(0, 2) : leaves.slice(1)
        const parent = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], originals)
        const job = yield* summaryJob(config.dataDir, chat.id, leaves[0]!.firstSlotId, leaves[2]!.lastSlotId, leaves)
        yield* fixtureSql(config.dataDir, [
          { sql: "UPDATE summarization_jobs SET absorbed_parent_id=? WHERE id=?", params: [parent.id, job.jobId] }
        ])
        const replacement = yield* writer.CompleteSummary({
          userId: user.id,
          ...job,
          content: "Absorbed",
          status: "complete",
          inputs: [],
          children: leaves.map((s) => ({ summaryId: s.id, revisionId: s.revisionId }))
        })
        assert.isTrue(replacement.fresh)
        for (const child of leaves)
          assert.strictEqual(
            (yield* api.GetSummary({ summaryId: child.id })).status,
            originals.includes(child) ? "complete" : "superseded"
          )
        assert.strictEqual((yield* api.GetSummary({ summaryId: parent.id })).status, "superseded")
      }).pipe(Effect.provide(serverLayer(config)))
    },
    { timeout: 60_000 }
  )
