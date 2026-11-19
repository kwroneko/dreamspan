// Bringing the merged chat's notes (spec/CHAT-MERGE.md §6; merge2, item 011a) through the real
// server: the preview lists the source chat's notes on at its end and its characters' card notes
// on there but off here, a moved passage and what's left of its field as one entry; only ticked
// ones come in, from the join on, on the merging branch only; the source keeps its own. Proven on
// the exact requests the characters' replies send. Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId, ForkId } from "@dreamspan/shared/chat.ts"
import { Effect, Exit } from "effect"
import { runMergeStory, sentText } from "./support/mergeOrigin.ts"

describe("bringing the merged chat's notes (merge2)", () => {
  it.live("the preview lists what's on there, and only the ticked notes come in, from the join on", () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const kai = yield* t.card("Kai")
        const docks = yield* t.chat("Docks", [kai])
        yield* t.say(docks, kai, "Kai mends the net.")
        const note = (doc: Record<string, unknown>) =>
          Effect.map(
            t.writer.CreateEntity({
              userId: t.userId,
              kind: "note",
              label: String(doc.title),
              subtitle: "",
              doc: { schema_version: 1, placement: { mode: "section", section: "tail_end" }, exportable: true, ...doc },
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            }),
            (ref) => ref.entityId as EntityId
          )
        const on = (at: typeof docks, entity: EntityId) => t.mark(at, { key: "note.activate", value: { note: entity } })
        // The Docks' own notes: one on for everyone, one on for Kai's turns, one off.
        const tide = yield* note({
          title: "Tide",
          content: "NOTE-TIDE The tide is high.",
          owner: { chat: docks.chatId }
        })
        const kaiTurn = yield* note({
          title: "Kai's habit",
          content: "NOTE-KAI-TURN Kai counts knots.",
          owner: { chat: docks.chatId },
          condition: { when: "turn", cards: [kai] }
        })
        const off = yield* note({ title: "Unused", content: "NOTE-OFF Never on.", owner: { chat: docks.chatId } })
        // Kai's card notes: one switched on in the Docks only; a moved passage, switched on there.
        const scar = yield* note({ title: "Scar", content: "CARD-SCAR Kai's scar aches.", owner: { card: kai } })
        const moved = yield* note({
          title: "Moved from Description",
          content: "CARD-MOVED Kai hides a coin.",
          owner: { card: kai },
          condition: { when: "own_turn" },
          placement: { mode: "section", section: "own_turn" },
          move_group: "g1"
        })
        const rest = yield* note({
          title: "Shared Description",
          content: "CARD-REST Kai is a fisher.",
          owner: { card: kai },
          replaces: { kind: "card_field", field: "description" },
          move_group: "g1"
        })
        // A replacement the Ledger already has: it can't come in.
        const main = { kind: "preset_prompt", identifier: "main" } as const
        yield* t.api.CreateChatNote({
          chatId: t.ledger.chatId,
          forkId: t.ledger.forkId,
          title: "Ledger main",
          replaces: main
        })
        const docksMain = yield* note({
          title: "Docks main",
          content: "NOTE-MAIN Docks rules.",
          owner: { chat: docks.chatId },
          replaces: main
        })
        for (const entity of [tide, kaiTurn, scar, moved, docksMain]) yield* on(docks, entity)
        void off

        // A branch of the Ledger from before the merge.
        const before = yield* t.tip(t.ledger)
        const sibling = (yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.ledger.chatId,
          fromForkId: t.ledger.forkId,
          atSlotId: before!
        })).fork.id as ForkId

        const sayBefore = yield* t.requestFor(t.ledger, t.mira)
        const seen = yield* t.preview(t.ledger, docks)
        const listed = seen.notes ?? []
        assert.deepStrictEqual(
          listed.map((n) => [n.kind, n.title, n.when, n.names, n.notes.length, n.conflict !== null]),
          [
            ["chat", "Docks main", "always", [], 1, true],
            ["chat", "Kai's habit", "turn", ["Kai"], 1, false],
            ["chat", "Tide", "always", [], 1, false],
            ["card", "Moved from Description", "moved", [], 2, false],
            ["card", "Scar", "always", [], 1, false]
          ]
        )
        assert.strictEqual(listed.find((n) => n.title === "Scar")?.card, "Kai")
        assert.include(listed.find((n) => n.title === "Tide")!.excerpt, "NOTE-TIDE")
        assert.sameMembers([...listed.find((n) => n.kind === "card" && n.when === "moved")!.notes], [moved, rest])

        const request = {
          chatId: t.ledger.chatId,
          forkId: t.ledger.forkId,
          at: null,
          source: { chatId: docks.chatId, forkId: docks.forkId },
          includeLeftOut: true,
          title: "Docks",
          framing: null,
          digest: seen.digest
        }
        const id = (title: string) => listed.find((n) => n.title === title)!.id
        // The conflicting note and a note that isn't listed are refused, and nothing is written.
        const conflicted = yield* Effect.exit(t.api.MergeChat({ ...request, notes: [id("Docks main")] }))
        assert.isTrue(Exit.isFailure(conflicted))
        assert.include(JSON.stringify(conflicted), "Only one note can replace this target")
        const unknown = yield* Effect.exit(t.api.MergeChat({ ...request, notes: [off] }))
        assert.isTrue(Exit.isFailure(unknown))
        assert.include(JSON.stringify(unknown), "isn't in the merged chat")

        yield* t.api.MergeChat({ ...request, notes: [id("Tide"), id("Kai's habit"), id("Moved from Description")] })

        const mira = sentText(yield* t.requestFor(t.ledger, t.mira))
        const kaiReply = sentText(yield* t.requestFor(t.ledger, kai))
        assert.notInclude(sentText(sayBefore), "NOTE-TIDE")
        assert.include(mira, "NOTE-TIDE", "a copied note for everyone reaches this chat's characters")
        assert.notInclude(mira, "NOTE-KAI-TURN", "Kai's-turn note isn't read on Mira's turn")
        assert.include(kaiReply, "NOTE-TIDE")
        assert.include(kaiReply, "NOTE-KAI-TURN", "Kai's-turn note is read on Kai's turn")
        assert.include(kaiReply, "CARD-MOVED", "the moved passage comes on with its group")
        assert.include(kaiReply, "CARD-REST", "what's left of the field comes on with it")
        for (const text of [mira, kaiReply]) {
          assert.notInclude(text, "CARD-SCAR", "an unticked card note stays off")
          assert.notInclude(text, "NOTE-MAIN")
          assert.notInclude(text, "NOTE-OFF")
        }

        // The copies are this chat's own notes; the Docks keeps its notes as they were.
        const here = yield* t.api.ListChatNotes({ chatId: t.ledger.chatId, forkId: t.ledger.forkId, slotId: null })
        const copied = here.filter((n) => ["Tide", "Kai's habit"].includes(String(n.doc["title"])))
        assert.strictEqual(copied.length, 2)
        for (const n of copied) {
          assert.deepStrictEqual(n.doc["owner"], { chat: t.ledger.chatId })
          assert.notInclude([tide, kaiTurn], n.ref.entityId)
        }
        const there = yield* t.api.ListChatNotes({ chatId: docks.chatId, forkId: docks.forkId, slotId: null })
        assert.includeMembers(
          there.map((n) => n.ref.entityId),
          [tide, kaiTurn, off, docksMain]
        )
        assert.include(sentText(yield* t.requestFor(docks, kai)), "NOTE-TIDE")

        // The other branch is untouched: no merge, no note on.
        const otherSide = sentText(yield* t.requestFor({ chatId: t.ledger.chatId, forkId: sibling }, t.mira))
        assert.notInclude(otherSide, "NOTE-TIDE")
        assert.notInclude(otherSide, "Kai mends the net.")
      })
    )
  )

  it.live("a branch of the same chat lists no notes to bring", () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        yield* t.say(t.ledger, t.mira, "Mira opens the ledger.")
        const tip = yield* t.tip(t.ledger)
        const branch = (yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.ledger.chatId,
          fromForkId: t.ledger.forkId,
          atSlotId: tip!
        })).fork.id as ForkId
        yield* t.say({ chatId: t.ledger.chatId, forkId: branch }, t.mira, "Mira counts coins.")
        const seen = yield* t.preview(t.ledger, { chatId: t.ledger.chatId, forkId: branch })
        assert.isUndefined(seen.notes)
      })
    )
  )
})
