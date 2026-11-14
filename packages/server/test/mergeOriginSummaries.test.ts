// Summaries after merging another chat with separate origins (merge2, item 056; CHARACTER-CONTEXT
// §2.3 [D], THREADS TH7's stretch views) through the real planner, worker and reader, with summary
// jobs still pending in both chats when the merge is made. The Ledger's summaries stay the
// Ledger's, the Pier's stay the Pier's: Kai's own summaries never carry the Ledger, Mira's never
// the Pier, neither reads the other's in its reply, and only the shared chain (a narrator's)
// holds both. Nothing is blended into a character's view. Synthetic data only.
import { assert, describe } from "@effect/vitest"
import { type ChatId, type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { STRETCH_VIEW } from "@rp/shared/knowledge.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { cardDoc } from "./support/docs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { lcmHarness, lcmTest, PAIRS_8K } from "./support/lcmHarness.ts"
import type { Recorded } from "./support/mockProvider.ts"
import { sentText } from "./support/threadStory.ts"

const filler = "The night ran on. ".repeat(20)

/** A summary says which chat's lines its request carried. */
const summarize = (request: Recorded) => {
  const body = JSON.stringify(request.body)
  return { text: `Seen:${body.includes("HOME") ? " home" : ""}${body.includes("DOCKS") ? " docks" : ""}.` }
}

describe("summaries after a merge kept separate (merge2)", () => {
  lcmTest(
    "each character's summaries keep to its own chat, with jobs pending in both chats at the merge",
    (server) =>
      Effect.gen(function* () {
        const h = yield* lcmHarness(server, {
          messages: 30,
          message: (n) => `HOME ${n}. ${filler}`,
          summarizer: summarize
        })
        const { api, writer, reader, userId } = h
        const ledger = h.chat.id as ChatId
        const card = (name: string) =>
          Effect.map(
            writer.CreateEntity({
              userId,
              kind: "card",
              label: name,
              subtitle: "",
              doc: cardDoc(name),
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            }),
            (c) => c.entityId as EntityId
          )
        const mira = yield* card("Mira")
        const kai = yield* card("Kai")
        yield* writer.AddStateEvent({
          userId,
          chatId: ledger,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "participant.join", value: { entity: mira } }
        })
        const F = (yield* api.GetChat({ chatId: ledger })).currentForkId! as ForkId
        const tipOf = (chatId: ChatId, fork: ForkId) =>
          Effect.map(
            reader.ReadPath({ userId, chatId, forkId: fork, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 }),
            (path) => (path.entries.at(-1)?.slotId ?? null) as SlotId | null
          )
        const say = (chatId: ChatId, fork: ForkId, speaker: EntityId, content: string) =>
          Effect.gen(function* () {
            const row = yield* writer.AppendMessage({
              userId,
              chatId,
              forkId: fork,
              parentSlotId: yield* tipOf(chatId, fork),
              branch: false,
              commitDraft: null,
              version: new NewVersion({
                speakerEntityId: speaker,
                writer: "model",
                content,
                status: "complete",
                macroMode: "verbatim",
                origin: "generated"
              })
            })
            if (chatId === ledger) h.rows.push(row)
            return row
          })
        for (let n = 0; n < 10; n++) yield* say(ledger, F, mira, `HOME more ${n}. ${filler}`)
        yield* h.settle

        // The Pier, with its own summaries, then more messages whose jobs are still pending.
        const pier = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Pier",
          participants: [kai],
          greeting: null
        })
        const P = pier.currentForkId! as ForkId
        yield* writer.AddStateEvent({
          userId,
          chatId: pier.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: {
            key: "lcm.settings",
            value: { enabled: true, leafInput: 500, leafTarget: 100, ...PAIRS_8K }
          }
        })
        const planPier = Effect.gen(function* () {
          return yield* h.summarizer.planNow(
            { userId, chatId: pier.id, leafSlotId: (yield* tipOf(pier.id, P))! },
            "reply"
          )
        })
        for (let n = 0; n < 80; n++) yield* say(pier.id, P, kai, `DOCKS ${n}. ${filler}`)
        for (let pass = 0; pass < 8; pass++) {
          yield* planPier
          if ((yield* h.drain).length === 0) break
        }
        for (let n = 0; n < 16; n++) yield* say(pier.id, P, kai, `DOCKS late ${n}. ${filler}`)
        for (let n = 0; n < 16; n++) yield* say(ledger, F, mira, `HOME late ${n}. ${filler}`)
        const pendingPier = yield* planPier
        const pendingLedger = yield* h.plan()
        assert.isNotEmpty(pendingPier, "the Pier has summary jobs pending at the merge")
        assert.isNotEmpty(pendingLedger, "the Ledger has summary jobs pending at the merge")

        // The merge, kept separate.
        const request = {
          chatId: ledger,
          forkId: F,
          at: null,
          source: { chatId: pier.id, forkId: P },
          includeLeftOut: false,
          timelines: "separate" as const
        }
        const seen = yield* api.PreviewChatMerge(request)
        assert.isAbove(seen.summarized, 0, "older Pier lines come through the Pier's own summaries")
        yield* api.MergeChat({ ...request, title: seen.sourceTitle, framing: null, digest: seen.digest })
        for (let n = 0; n < 80; n++) yield* say(ledger, F, n % 2 ? kai : mira, `After ${n}. ${filler}`)
        yield* h.settle

        const [jobs] = yield* fixtureSql(
          h.dataDir,
          [
            {
              sql: `SELECT j.audience_json AS audience, p.context_snapshot_json AS snapshot FROM summarization_jobs j
                JOIN rollout_payloads p ON p.rollout_id = j.rollout_id WHERE j.chat_id = ?`,
              params: [ledger]
            }
          ],
          { readOnly: true }
        )
        const requests = (jobs as unknown as Array<{ audience: string | null; snapshot: string }>).map((r) => ({
          audience: r.audience === null ? null : (JSON.parse(r.audience) as Array<string>),
          text: sentText(JSON.parse(r.snapshot) as ContextSnapshot)
        }))
        const kaiOwn = requests.filter((r) => r.audience?.includes(kai))
        const miraOwn = requests.filter((r) => r.audience?.includes(mira))
        assert.isNotEmpty(kaiOwn, "Kai keeps his own summaries")
        assert.isNotEmpty(miraOwn, "Mira keeps her own summaries")
        for (const r of [...kaiOwn, ...miraOwn]) assert.include(r.audience!, STRETCH_VIEW)
        for (const r of kaiOwn) assert.notMatch(r.text, /HOME|Seen: home/, "Kai's summaries never read the Ledger")
        for (const r of miraOwn) assert.notMatch(r.text, /DOCKS|docks/, "Mira's summaries never read the Pier")
        assert.isTrue(
          requests.some((r) => r.audience === null && /home/i.test(r.text) && /docks/i.test(r.text)),
          "only the shared chain (a narrator's) holds both"
        )

        const [stored] = yield* fixtureSql(
          h.dataDir,
          [
            {
              sql: `SELECT s.audience_json AS audience, r.content FROM summaries s
                JOIN summary_revisions r ON r.id = s.selected_revision_id
                WHERE s.chat_id = ? AND s.status IN ('complete', 'truncated')`,
              params: [ledger]
            }
          ],
          { readOnly: true }
        )
        for (const s of stored as unknown as Array<{ audience: string | null; content: string }>) {
          if (s.audience?.includes(kai)) assert.notInclude(s.content, "home")
          if (s.audience?.includes(mira)) assert.notInclude(s.content, "docks")
        }

        // Their replies read their own layers.
        const replyBy = (speaker: EntityId) =>
          Effect.gen(function* () {
            const placeholder = yield* writer.AppendMessage({
              userId,
              chatId: ledger,
              forkId: F,
              parentSlotId: (yield* tipOf(ledger, F))!,
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
              chatId: ledger,
              slotId: placeholder.slotId,
              versionId: placeholder.version.id,
              now: 1,
              timeZone: "UTC",
              frozen: null,
              forkId: placeholder.forkId
            })
            return sentText(JSON.parse(built.snapshot) as ContextSnapshot)
          })
        const forKai = yield* replyBy(kai)
        assert.notMatch(forKai, /HOME|Seen: home/)
        assert.include(forKai, "After 79")
        const forMira = yield* replyBy(mira)
        assert.notMatch(forMira, /DOCKS|docks/)
        assert.include(forMira, "After 79")
      }),
    { timeout: 300_000 }
  )
})
