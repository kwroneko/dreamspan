// Merging another chat with separate origins (DESIGN "Merging another chat into this one" [D]
// 2026-11-08: "the timelines remain separate for the characters from chat A and chat B"; merge2,
// item 056) through the real server, proven on the exact request each character's reply sends.
// In a chat with one shared context, a merge kept separate leaves each character with its own
// chat's past: the Ledger's characters keep reading the Ledger exactly as before (byte-identical
// requests) and nothing of the Docks; the Docks' characters read the Docks lines they were there
// for and nothing of the Ledger's past; everyone reads what follows the join; the narrator reads
// both. Adversarial: an earlier merge in the destination and a merge inside the source, away
// periods across the join on both sides, own-turn notes, a branch merged together beside it.
// Synthetic data only.
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { cardDoc } from "./support/docs.ts"
import { runMergeStory, sentText } from "./support/mergeOrigin.ts"
import { runStory, sentText as threadText } from "./support/threadStory.ts"

const LEDGER = [
  "The road flooded.",
  "HOME-1 Mira opens the ledger.",
  "HOME-AWAY Mira hides the ledger under the floor."
]
const DOCKS = ["SRC-1 Kai mends the net.", "SRC-2 Lio counts gulls.", "SRC-3 Lio whistles at the tide."]
const LIO_MISSED = ["SRC-SECRET Kai buries the coin by the pier.", "SRC-TIP Kai locks the shed."]

/** A request's messages from the chat's first message (the greeting) on: its history and tail. */
const fromFirstMessage = (snapshot: ContextSnapshot) => {
  const messages = snapshot.request.messages
  return messages.slice(messages.findIndex((m) => JSON.stringify(m.content).includes("Late again")))
}

const includesAll = (text: string, lines: ReadonlyArray<string>, who: string) => {
  for (const line of lines) assert.include(text, line, `${who} reads “${line}”`)
}
const includesNone = (text: string, lines: ReadonlyArray<string>, who: string) => {
  for (const line of lines) assert.notInclude(text, line, `${who} never reads “${line}”`)
}

describe("merging another chat with separate origins (merge2)", () => {
  it.live(
    "each character keeps its own chat's past and reads what follows the join; the narrator reads both",
    () =>
      runMergeStory((t) =>
        Effect.gen(function* () {
          const kai = yield* t.card("Kai")
          const lio = yield* t.card("Lio")
          const cara = yield* t.card("Cara")
          const dax = yield* t.card("Dax")
          yield* t.ownTurnNote(t.mira, "MIRA-OWN-TURN")
          yield* t.ownTurnNote(kai, "KAI-OWN-TURN")

          // The Ledger: an earlier merge of another chat (together), then Wren leaves and stays
          // away across the coming join.
          const cove = yield* t.chat("Cove", [cara])
          yield* t.say(cove, cara, "CEE Cara sings in the cove.")
          yield* t.say(t.ledger, t.mira, "HOME-1 Mira opens the ledger.")
          yield* t.merge(t.ledger, cove, "together")
          yield* t.away(t.ledger, t.wren, true)
          yield* t.say(t.ledger, t.mira, "HOME-AWAY Mira hides the ledger under the floor.")

          // The Docks: Kai and Lio; Lio misses one message, then is away again at the tip; a
          // chat merged into the Docks itself, whose lines are never merged again.
          const docks = yield* t.chat("Docks", [kai, lio])
          const sea = yield* t.chat("Open sea", [dax])
          yield* t.say(sea, dax, "NESTED Dax sails past.")
          yield* t.say(docks, kai, DOCKS[0]!)
          yield* t.say(docks, lio, DOCKS[1]!)
          yield* t.merge(docks, sea, "together")
          yield* t.away(docks, lio, true)
          yield* t.say(docks, kai, LIO_MISSED[0]!)
          yield* t.away(docks, lio, false)
          yield* t.say(docks, lio, DOCKS[2]!)
          yield* t.away(docks, lio, true)
          yield* t.say(docks, kai, LIO_MISSED[1]!)

          // Requests before the merge.
          const before = {
            mira: yield* t.requestFor(t.ledger, t.mira),
            wren: yield* t.requestFor(t.ledger, t.wren),
            cara: yield* t.requestFor(t.ledger, cara)
          }
          includesAll(sentText(before.wren), [...LEDGER, "CEE Cara sings"], "Wren, in one shared context")
          const atM = (yield* t.tip(t.ledger))!

          // The dialog's choice and its views.
          const together = yield* t.preview(t.ledger, docks)
          assert.isTrue(together.choosesTimelines)
          assert.isUndefined(together.views)
          const seen = yield* t.preview(t.ledger, docks, "separate")
          assert.strictEqual(seen.timelines, "separate")
          const view = (id: string) => seen.views!.find((v) => v.entity === id)!
          assert.deepStrictEqual(
            [view(t.mira).from, view(t.wren).from, view(cara).from, view(kai).from, view(lio).from],
            ["here", "here", "here", "merged", "merged"]
          )
          assert.isFalse(view(t.mira).readable)
          assert.isTrue(view(kai).readable)
          assert.include(view(lio).section, "SRC-2 Lio counts gulls.")
          assert.notInclude(view(lio).section, "SRC-SECRET")
          assert.isUndefined(
            seen.views!.find((v) => v.entity === t.nara),
            "the narrator reads it all"
          )

          const { slotId: J } = yield* t.merge(t.ledger, docks, "separate")
          const row = yield* t.stored(J)
          assert.strictEqual(row.timelines, "separate")
          assert.isNull(row.split_id)
          assert.isNull(row.stretch_before_slot_id, "another chat's characters lived none of the Ledger")

          // The Ledger's characters: from the first message on, their requests are byte-identical
          // to before the merge. Only the cast differs (the union, DESIGN §3.3 [D]): the newcomers'
          // definitions and names at the top.
          const after = {
            mira: yield* t.requestFor(t.ledger, t.mira),
            wren: yield* t.requestFor(t.ledger, t.wren),
            cara: yield* t.requestFor(t.ledger, cara)
          }
          for (const who of ["mira", "wren", "cara"] as const) {
            assert.deepStrictEqual(
              fromFirstMessage(after[who]),
              fromFirstMessage(before[who]),
              `${who}: the merge changes nothing of the history she reads`
            )
            assert.strictEqual(after[who].request.messages.length, before[who].request.messages.length)
          }
          includesNone(sentText(after.mira), [...DOCKS, ...LIO_MISSED, "NESTED", "KAI-OWN-TURN"], "Mira")
          includesAll(sentText(after.mira), ["MIRA-OWN-TURN", "CEE Cara sings"], "Mira")
          includesAll(sentText(after.wren), LEDGER, "Wren (away in one shared context)")
          includesNone(sentText(after.wren), [...DOCKS, ...LIO_MISSED, "MIRA-OWN-TURN"], "Wren")

          // The Docks' characters: what they were there for, nothing of the Ledger's past.
          const forKai = sentText(yield* t.requestFor(t.ledger, kai))
          includesAll(forKai, [...DOCKS, ...LIO_MISSED, "KAI-OWN-TURN"], "Kai")
          includesNone(forKai, [...LEDGER, "CEE Cara sings", "NESTED Dax", "MIRA-OWN-TURN", "Late again"], "Kai")
          const forLio = sentText(yield* t.requestFor(t.ledger, lio))
          includesAll(forLio, DOCKS, "Lio")
          includesNone(forLio, [...LIO_MISSED, ...LEDGER, "CEE Cara sings", "KAI-OWN-TURN"], "Lio")

          // The narrator: both chats, the Docks as the labelled section.
          const forNara = sentText(yield* t.requestFor(t.ledger, t.nara))
          includesAll(forNara, [...LEDGER, ...DOCKS, ...LIO_MISSED, "CEE Cara sings", "Meanwhile"], "Nara")

          // After the join: everyone reads what follows.
          yield* t.say(t.ledger, t.mira, "AFTER Mira greets the newcomers.")
          for (const [who, id] of [
            ["Kai", kai],
            ["Lio", lio],
            ["Wren", t.wren],
            ["Mira", t.mira]
          ] as const)
            assert.include(sentText(yield* t.requestFor(t.ledger, id)), "AFTER Mira greets", who)

          // Causal order: a reply placed before the join reads nothing of the Docks.
          assert.notInclude(sentText(yield* t.requestFor(t.ledger, t.mira, atM)), "SRC-1")

          // Branches are independent: a branch from before the join, merged together, reads both
          // for everyone, and the separate merge on the main branch changes nothing there.
          const branch = yield* t.writer.CreateFork({
            userId: t.userId,
            chatId: t.ledger.chatId,
            fromForkId: t.ledger.forkId,
            atSlotId: atM
          })
          const other = { chatId: t.ledger.chatId, forkId: branch.fork.id as ForkId }
          yield* t.merge(other, docks, "together")
          const kaiThere = sentText(yield* t.requestFor(other, kai))
          includesAll(kaiThere, ["HOME-AWAY", "SRC-1", "Meanwhile"], "Kai, merged together")
          const forKaiAgain = sentText(yield* t.requestFor(t.ledger, kai))
          includesNone(forKaiAgain, LEDGER, "Kai on the main branch")
        })
      ),
    { timeout: 120_000 }
  )

  it.live("threads in the destination and in the source: each character still keeps only its own past", () =>
    runStory(null, (t) =>
      Effect.gen(function* () {
        const { writer, userId } = t
        const kai = (yield* writer.CreateEntity({
          userId,
          kind: "card",
          label: "Kai",
          subtitle: "",
          doc: cardDoc("Kai"),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })).entityId as EntityId
        const harbor = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Harbor",
          participants: [kai],
          greeting: null
        })
        const H = { chatId: harbor.id, forkId: harbor.currentForkId! as ForkId }
        yield* writer.AppendMessage({
          userId,
          chatId: H.chatId,
          forkId: H.forkId,
          parentSlotId: null,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: kai,
            writer: "model",
            content: "EXT-1 Kai rows into the harbor.",
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        yield* t.append(t.F, t.mira, "LANTERN-1 Mira stokes the fire.")
        yield* t.append(t.D, t.wren, "DOCKS-1 Wren counts the crates.")
        const mergeInto = (into: { chatId: ChatId; forkId: ForkId }, source: { chatId: ChatId; forkId: ForkId }) =>
          Effect.gen(function* () {
            const request = {
              chatId: into.chatId,
              forkId: into.forkId,
              at: null,
              source,
              includeLeftOut: true,
              timelines: "separate" as const
            }
            const seen = yield* t.api.PreviewChatMerge(request)
            return yield* t.api.MergeChat({ ...request, title: seen.sourceTitle, framing: null, digest: seen.digest })
          })

        // The source is a thread: merged into the Harbor, kept separate.
        yield* mergeInto(H, { chatId: t.chatId, forkId: t.D })
        const requestIn = (speaker: EntityId) =>
          Effect.gen(function* () {
            const tip = (yield* t.reader.ReadPath({
              userId,
              chatId: H.chatId,
              forkId: H.forkId,
              leafSlotId: null,
              range: { _tag: "Bottom" },
              limit: 1
            })).entries.at(-1)!.slotId
            const placeholder = yield* writer.AppendMessage({
              userId,
              chatId: H.chatId,
              forkId: H.forkId,
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
            const built = yield* t.reader.AssembleContext({
              userId,
              chatId: H.chatId,
              slotId: placeholder.slotId,
              versionId: placeholder.version.id,
              now: 1,
              timeZone: "UTC",
              frozen: null,
              forkId: placeholder.forkId
            })
            return threadText(JSON.parse(built.snapshot) as ContextSnapshot)
          })
        const harborWren = yield* requestIn(t.wren)
        includesAll(harborWren, ["The road flooded.", "DOCKS-1"], "Wren, from her thread")
        includesNone(harborWren, ["EXT-1", "LANTERN-1"], "Wren")
        const harborMira = yield* requestIn(t.mira)
        includesAll(harborMira, ["The road flooded."], "Mira, before the threads parted")
        includesNone(harborMira, ["DOCKS-1", "EXT-1", "LANTERN-1"], "Mira, assigned to another thread")
        const harborKai = yield* requestIn(kai)
        includesAll(harborKai, ["EXT-1"], "Kai")
        includesNone(harborKai, ["DOCKS-1", "The road flooded."], "Kai")

        // The destination has threads: the Harbor merged into the Lantern, kept separate.
        const wrenBefore = yield* t.requestFor(t.F, t.wren)
        yield* mergeInto({ chatId: t.chatId, forkId: t.F }, H)
        const wrenAfter = yield* t.requestFor(t.F, t.wren)
        assert.deepStrictEqual(
          fromFirstMessage(wrenAfter),
          fromFirstMessage(wrenBefore),
          "Wren keeps the Lantern as she read it"
        )
        const lanternKai = threadText(yield* t.requestFor(t.F, kai))
        includesAll(lanternKai, ["EXT-1"], "Kai")
        includesNone(lanternKai, ["LANTERN-1", "The road flooded.", "DOCKS-1"], "Kai in the Lantern")
        // Then the docks join the Lantern, kept separate: the thread's own rule on top.
        yield* t.join(t.F, [t.D], null, "separate")
        includesAll(threadText(yield* t.requestFor(t.F, t.wren)), ["DOCKS-1"], "Wren, her docks")
        const miraNow = threadText(yield* t.requestFor(t.F, t.mira))
        includesAll(miraNow, ["LANTERN-1"], "Mira")
        includesNone(miraNow, ["DOCKS-1", "EXT-1"], "Mira")
        includesNone(threadText(yield* t.requestFor(t.F, kai)), ["DOCKS-1", "LANTERN-1"], "Kai")
      })
    )
  )

  it.live("a character in both chats keeps both pasts; one who left the Ledger keeps what it was there for", () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const kai = yield* t.card("Kai")
        // Wren is in the Docks too; Kai was in the Ledger once and left before the merge.
        yield* t.mark(t.ledger, { key: "participant.join", value: { entity: kai } })
        yield* t.say(t.ledger, kai, "ONCE Kai visits the Ledger.")
        yield* t.mark(t.ledger, { key: "participant.leave", value: { entity: kai } })
        yield* t.say(t.ledger, t.mira, "GONE Mira watches Kai leave.")
        const docks = yield* t.chat("Docks", [kai, t.wren])
        yield* t.say(docks, kai, "SRC-1 Kai mends the net.")
        yield* t.say(docks, t.wren, "SRC-2 Wren trades lamp oil.")
        const seen = yield* t.preview(t.ledger, docks, "separate")
        assert.strictEqual(seen.views!.find((v) => v.entity === t.wren)!.from, "both")
        assert.strictEqual(seen.views!.find((v) => v.entity === kai)!.from, "merged")
        yield* t.merge(t.ledger, docks, "separate")
        const forWren = sentText(yield* t.requestFor(t.ledger, t.wren))
        includesAll(forWren, ["GONE Mira", "SRC-1", "SRC-2"], "Wren, in both chats")
        const forKai = sentText(yield* t.requestFor(t.ledger, kai))
        includesAll(forKai, ["ONCE Kai visits", "SRC-1", "SRC-2"], "Kai")
        includesNone(forKai, ["GONE Mira", "The road flooded."], "Kai, after he left the Ledger")
        const forMira = sentText(yield* t.requestFor(t.ledger, t.mira))
        includesNone(forMira, ["SRC-1", "SRC-2"], "Mira")
      })
    )
  )
})
