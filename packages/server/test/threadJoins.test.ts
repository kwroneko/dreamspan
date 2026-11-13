// Joining threads (spec/THREADS.md §7, TH5) through the real server: Mira at the Lantern (the
// branch the threads started in), Wren at the docks, Pell upstairs and Quill in the garden, the
// user playing Tobin. A join is the built chat merge with another thread as its source: its row
// names the split and how the characters read it, its frozen rows the versions they copy, and the
// joined thread's characters are present again from the join on. Re-joining brings only what's
// new; three threads join at once as consecutive joins; deleting a join takes all that back. In a
// chat with separate contexts the preview shows what each character reads, and Mira's next
// request has nothing of the docks while Wren's has it all. Synthetic data only.
import { DatabaseSync } from "node:sqlite"
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { awayAt } from "@rp/shared/knowledge.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const mockProvider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((_request, res) =>
      sse(res, completionChunks(["The night goes on."], { prompt_tokens: 10, completion_tokens: 4 }))
    )
  ),
  (m) => Effect.promise(() => m.close())
)

const sentText = (snapshot: ContextSnapshot) =>
  snapshot.request.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as ReadonlyArray<{ text?: string }>).map((p) => p.text ?? "").join("")
    )
    .join("\n")

const story = (dataDir: string, setting: "separate" | null) =>
  Effect.gen(function* () {
    const mock = yield* mockProvider
    const api = yield* client()
    const reader = yield* Reader
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const made = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: ["Wren", "Pell", "Quill"],
      state: setting ? [{ key: "context.per_speaker", value: setting }] : []
    })
    const chatId = made.chat.id
    const mira = made.mira.entityId as EntityId
    const [wren, pell, quill] = made.characters.map((card) => card.entityId as EntityId) as [
      EntityId,
      EntityId,
      EntityId
    ]
    const F = made.chat.currentForkId! as ForkId
    const S = made.version.slotId as SlotId
    const tobin = foldState(yield* reader.StateEventsAt({ userId, chatId, slotId: S, forkId: F }))
      .playedByMe[0] as EntityId
    const rowVersion = (slotId: SlotId, forkId: ForkId) =>
      Effect.map(reader.GetSlot({ userId, slotId, forkId }), (slot) => slot.entry.rowVersion)
    // A branch made before the threads: never one of them.
    const before = (yield* writer.CreateFork({ userId, chatId, fromForkId: F, atSlotId: S })).fork.id as ForkId
    const started = yield* api.StartThreads({
      chatId,
      forkId: F,
      slotId: S,
      expectedRowVersion: yield* rowVersion(S, F),
      threads: [
        { name: "At the Lantern", cast: [mira], writesAs: null },
        { name: "At the docks", cast: [wren], writesAs: null },
        { name: "Upstairs", cast: [pell], writesAs: null },
        { name: "In the garden", cast: [quill], writesAs: null }
      ]
    })
    const [, D, U, G] = started.forkIds as [ForkId, ForkId, ForkId, ForkId]
    const append = (fork: ForkId, speaker: EntityId, content: string, model = true) =>
      Effect.gen(function* () {
        const tip = (yield* reader.ReadPath({
          userId,
          chatId,
          forkId: fork,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries.at(-1)!.slotId
        return yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: fork,
          parentSlotId: tip,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: model ? "model" : "human",
            content,
            status: "complete",
            macroMode: "verbatim",
            origin: model ? "generated" : "user_written"
          })
        })
      })
    /** Who is away at `slotId` (null: the tip) in `fork`. */
    const awayIn = (fork: ForkId, slotId: SlotId) =>
      Effect.map(reader.StateEventsAt({ userId, chatId, slotId, forkId: fork }), (events) => awayAt(foldState(events)))
    /** The context of a reply by `speaker` at the tip of `fork`: its own placeholder row (a branch there). */
    const contextFor = (fork: ForkId, speaker: EntityId) =>
      Effect.gen(function* () {
        const tip = (yield* reader.ReadPath({
          userId,
          chatId,
          forkId: fork,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries.at(-1)!.slotId
        // A placeholder: generating, never sent.
        const placeholder = yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: fork,
          parentSlotId: tip,
          branch: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: speaker,
            writer: "model",
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const built = yield* reader.AssembleContext({
          userId,
          chatId,
          slotId: placeholder.slotId,
          versionId: placeholder.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null,
          forkId: placeholder.forkId
        })
        return sentText(JSON.parse(built.snapshot) as ContextSnapshot)
      })
    /** The stored rows of the join at `slotId`, read beside the server on the database file. */
    const stored = (slotId: SlotId) => {
      const db = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      try {
        const merge = db
          .prepare("SELECT id, split_id, timelines, title, cast_json FROM chat_merges WHERE slot_id = ?")
          .get(slotId) as { id: string; split_id: string | null; timelines: string; title: string; cast_json: string }
        const rows = db
          .prepare(
            `SELECT kind, source_slot_id, source_version_id, media_json, knowers_json, content FROM chat_merge_messages
              WHERE merge_id = ? ORDER BY ordinal`
          )
          .all(merge.id) as Array<{
          kind: string
          source_slot_id: string | null
          source_version_id: string | null
          media_json: string | null
          knowers_json: string | null
          content: string
        }>
        return { merge, rows }
      } finally {
        db.close()
      }
    }
    const preview = (into: ForkId, source: ForkId, at: SlotId | null = null) =>
      api.PreviewChatMerge({ chatId, forkId: into, at, source: { chatId, forkId: source }, includeLeftOut: false })
    const join = (into: ForkId, sources: ReadonlyArray<ForkId>, at: SlotId | null = null) =>
      Effect.gen(function* () {
        const previews = yield* Effect.forEach(sources, (source) => preview(into, source, at))
        return yield* api.JoinThreads({
          chatId,
          forkId: into,
          at,
          includeLeftOut: false,
          joins: previews.map((p, i) => ({
            forkId: sources[i]!,
            title: p.sourceTitle,
            framing: null,
            digest: p.digest
          }))
        })
      })
    return {
      api,
      reader,
      writer,
      userId,
      chatId,
      mira,
      wren,
      pell,
      quill,
      tobin,
      F,
      D,
      U,
      G,
      S,
      before,
      splitId: started.splitId,
      append,
      awayIn,
      contextFor,
      stored,
      preview,
      join
    }
  })

const run = <A, E, R>(
  setting: "separate" | null,
  use: (t: Effect.Success<ReturnType<typeof story>>) => Effect.Effect<A, E, R>
) => {
  const config = testConfig()
  return Effect.gen(function* () {
    return yield* use(yield* story(config.dataDir, setting))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
}

describe("joining threads", () => {
  it.live("a join of the docks into the Lantern: its rows, Wren back, re-joining only what's new, deleting it", () =>
    run(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.F, t.mira, "Mira stokes the fire at the Lantern.")
        const gulls = yield* t.append(t.D, t.wren, "Wren: Gulls scream over the empty docks.")
        const wave = yield* t.append(t.D, t.tobin, "Tobin waves the lantern twice.", false)

        // What it brings, as the dialog shows it: the docks' two messages, Wren back.
        const seen = yield* t.preview(t.F, t.D)
        assert.isTrue(seen.thread)
        assert.strictEqual(seen.timelines, "together")
        assert.deepStrictEqual(seen.back, [t.wren])
        assert.deepStrictEqual(seen.castNames, ["Wren"])
        assert.strictEqual(seen.framing, "Meanwhile, in parallel with what follows: At the docks, with Wren.")
        assert.strictEqual(seen.messages, 2)
        assert.isFalse(seen.continues)
        assert.isUndefined(seen.views)
        assert.include(seen.section, "Gulls scream over the empty docks.")
        assert.notInclude(seen.section, "stokes the fire")

        assert.include(yield* t.awayIn(t.F, (yield* t.append(t.F, t.mira, "Mira waits.")).slotId), t.wren)
        const joined = yield* t.join(t.F, [t.D])
        assert.strictEqual(joined.entries.length, 1)
        const J = joined.entries[0]!.slotId
        assert.strictEqual(joined.entries[0]!.version.origin, "merge")

        // The stored join: the split, the view, the copied versions.
        const { merge, rows } = t.stored(J)
        assert.strictEqual(merge.split_id, t.splitId)
        assert.strictEqual(merge.timelines, "together")
        assert.strictEqual(merge.title, "At the docks")
        assert.deepStrictEqual(
          rows.map((r) => [r.kind, r.source_slot_id, r.source_version_id, r.media_json, r.content]),
          [
            ["message", gulls.slotId, gulls.version.id, null, "Wren: Gulls scream over the empty docks."],
            ["message", wave.slotId, wave.version.id, null, "Tobin waves the lantern twice."]
          ]
        )
        assert.include(JSON.parse(rows[0]!.knowers_json!) as Array<string>, t.wren)
        assert.notInclude(JSON.parse(rows[0]!.knowers_json!) as Array<string>, t.mira)
        assert.isTrue((yield* t.api.GetMerge({ chatId: t.chatId, slotId: J })).thread)

        // Wren is here from the join on, not before it; the docks keep their own marks.
        assert.notInclude(yield* t.awayIn(t.F, J), t.wren)
        assert.include(yield* t.awayIn(t.D, wave.slotId), t.mira)

        // "Joined at #N", nothing new since; then something new, and a second join brings only it.
        const docksThread = (sets: ReadonlyArray<{ threads: ReadonlyArray<{ ordinal: number; joined?: unknown }> }>) =>
          sets[0]!.threads.find((thread) => thread.ordinal === 1)!.joined as
            { slotId: SlotId; number: number; upToDate: boolean } | undefined
        const first = docksThread(yield* t.api.ThreadsOf({ chatId: t.chatId, forkId: t.F }))
        assert.deepStrictEqual(first, { slotId: J, number: joined.entries[0]!.position! + 1, upToDate: true })
        assert.isUndefined(docksThread(yield* t.api.ThreadsOf({ chatId: t.chatId, forkId: t.D })))
        assert.strictEqual(yield* outcome(t.preview(t.F, t.D)), "MergeRefused")
        yield* t.append(t.D, t.wren, "Wren: A ship's light, far out.")
        assert.isFalse(docksThread(yield* t.api.ThreadsOf({ chatId: t.chatId, forkId: t.F }))!.upToDate)
        const again = yield* t.preview(t.F, t.D)
        assert.isTrue(again.continues)
        assert.strictEqual(again.messages, 1)
        assert.deepStrictEqual(again.back, [])
        const second = (yield* t.join(t.F, [t.D])).entries[0]!.slotId
        assert.deepStrictEqual(
          t.stored(second).rows.map((r) => r.content),
          ["Wren: A ship's light, far out."]
        )

        // Deleting both joins takes it back: Wren away again, nothing joined, all three to bring.
        yield* t.api.DeleteMessage({ slotId: second, forkId: t.F })
        yield* t.api.DeleteMessage({ slotId: J, forkId: t.F })
        assert.isUndefined(docksThread(yield* t.api.ThreadsOf({ chatId: t.chatId, forkId: t.F })))
        const tip = yield* t.append(t.F, t.mira, "Mira banks the fire.")
        assert.include(yield* t.awayIn(t.F, tip.slotId), t.wren)
        const fresh = yield* t.preview(t.F, t.D)
        assert.isFalse(fresh.continues)
        assert.strictEqual(fresh.messages, 3)
      })
    )
  )

  it.live("three threads join at once, as consecutive joins, each with its own characters back", () =>
    run(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.D, t.wren, "Wren counts the moored boats.")
        yield* t.append(t.U, t.pell, "Pell lights a candle upstairs.")
        yield* t.append(t.G, t.quill, "Quill hums among the herbs.")
        yield* t.append(t.F, t.mira, "Mira listens to the rain.")
        const joined = yield* t.join(t.F, [t.D, t.U, t.G])
        assert.deepStrictEqual(
          joined.entries.map((e) => e.position),
          [0, 1, 2].map((i) => joined.entries[0]!.position! + i)
        )
        assert.deepStrictEqual(
          joined.entries.map((e) => t.stored(e.slotId).merge.title),
          ["At the docks", "Upstairs", "In the garden"]
        )
        assert.isTrue(joined.entries.every((e) => t.stored(e.slotId).merge.split_id === t.splitId))
        const last = joined.entries[2]!.slotId
        const away = yield* t.awayIn(t.F, last)
        for (const back of [t.wren, t.pell, t.quill]) assert.notInclude(away, back)
        // Pell is back from the second join on, not at the first.
        assert.include(yield* t.awayIn(t.F, joined.entries[0]!.slotId), t.pell)
        const sets = yield* t.api.ThreadsOf({ chatId: t.chatId, forkId: t.F })
        assert.deepStrictEqual(
          sets[0]!.threads.map((thread) => thread.joined?.slotId ?? null),
          [null, ...joined.entries.map((e) => e.slotId)]
        )
      })
    )
  )

  it.live(
    "separate contexts: the preview shows each character's view, and Mira's next request has none of the docks",
    () =>
      run("separate", (t) =>
        Effect.gen(function* () {
          yield* t.append(t.F, t.mira, "Mira stokes the fire at the Lantern.")
          yield* t.append(t.D, t.wren, "Wren: Gulls scream over the empty docks.")
          const seen = yield* t.preview(t.F, t.D)
          assert.strictEqual(seen.timelines, "separate")
          const view = (entity: EntityId) => seen.views!.find((v) => v.entity === entity)!
          assert.isFalse(view(t.mira).readable)
          assert.strictEqual(view(t.mira).section, "")
          assert.isTrue(view(t.wren).readable)
          assert.include(view(t.wren).section, "Gulls scream over the empty docks.")
          // The user's own card reads it all: it has no view of its own.
          assert.isUndefined(seen.views!.find((v) => v.entity === t.tobin))

          const J = (yield* t.join(t.F, [t.D])).entries[0]!.slotId
          assert.strictEqual(t.stored(J).merge.timelines, "separate")
          const forMira = yield* t.contextFor(t.F, t.mira)
          assert.include(forMira, "Mira stokes the fire")
          assert.notInclude(forMira, "Gulls scream")
          const forWren = yield* t.contextFor(t.F, t.wren)
          assert.include(forWren, "Gulls scream over the empty docks.")
        })
      )
  )

  it.live("only other threads of this branch join; each once", () =>
    run(null, (t) =>
      Effect.gen(function* () {
        yield* t.append(t.D, t.wren, "Wren counts the moored boats.")
        yield* t.append(t.before, t.mira, "A branch from before the threads.")
        assert.strictEqual(yield* outcome(t.join(t.F, [t.before])), "MergeRefused")
        const seen = yield* t.preview(t.F, t.D)
        assert.strictEqual(
          yield* outcome(
            t.api.JoinThreads({
              chatId: t.chatId,
              forkId: t.F,
              at: null,
              includeLeftOut: false,
              joins: [0, 1].map(() => ({ forkId: t.D, title: "At the docks", framing: null, digest: seen.digest }))
            })
          ),
          "MergeRefused"
        )
        // Nothing was written.
        const sets = yield* t.api.ThreadsOf({ chatId: t.chatId, forkId: t.F })
        assert.isTrue(sets[0]!.threads.every((thread) => thread.joined === undefined))
      })
    )
  )
})
