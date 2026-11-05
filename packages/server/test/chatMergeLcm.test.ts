// A merged chat through the real reader, summarizer and mock provider (spec/CHAT-MERGE.md §4,
// §5): the next reply's request places the source's section by the chat's layout with the join
// marker at the join, and a summary request over the join asks for one section per line.
import { assert } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { lcmHarness, lcmTest, requestsTo } from "./support/lcmHarness.ts"
import type { Recorded } from "./support/mockProvider.ts"

const texts = (request: Recorded) =>
  ((request.body?.messages ?? []) as Array<{ content: string | Array<{ text?: string }> }>)
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("")))
    .join("\n")

const ascending = (haystack: string, needles: ReadonlyArray<string>) => {
  const at = needles.map((n) => {
    const i = haystack.indexOf(n)
    assert.isAtLeast(i, 0, `missing ${n}`)
    return i
  })
  assert.deepStrictEqual(
    at,
    [...at].sort((a, b) => a - b)
  )
}

const harness = (server: Parameters<typeof lcmHarness>[0]) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, {
      messages: 6,
      summarizer: (request) => ({
        text: texts(request).includes("one section per line") ? "SUMMARY(two lines)" : "SUMMARY(one line)"
      })
    })
    const forkId = h.chat.currentForkId! as ForkId
    const away = yield* h.writer.CreateChat({
      userId: h.userId,
      kind: "rp",
      status: "active",
      title: "Docks",
      participants: [],
      greeting: null
    })
    let parent: SlotId | null = null
    for (const text of ["Docks one. The crane creaked.", "Docks two. The tide came in."])
      parent = (yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId: away.id,
        parentSlotId: parent,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: text,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })).slotId
    const source = { chatId: away.id as ChatId, forkId: away.currentForkId! as ForkId }
    const merge = (start: SlotId | null) =>
      Effect.gen(function* () {
        const request = { chatId: h.chat.id, forkId, at: null, source, start, includeLeftOut: false }
        const seen = yield* h.reader.PreviewChatMerge({ userId: h.userId, ...request })
        return yield* h.writer.MergeChat({
          userId: h.userId,
          ...request,
          title: seen.sourceTitle,
          framing: null,
          digest: seen.digest
        })
      })
    const reply = (parentSlotId: SlotId) =>
      Effect.gen(function* () {
        const row = yield* h.append("Message 9. The reply.", parentSlotId)
        const built = JSON.parse(
          (yield* h.reader.AssembleContext({
            userId: h.userId,
            chatId: h.chat.id,
            forkId,
            slotId: row.slotId,
            versionId: row.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })).snapshot
        ) as ContextSnapshot
        return built
      })
    const layout = (id: string) =>
      h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "merge.layout", value: id }
      })
    return { ...h, forkId, merge, reply, layout }
  })

const all = (snapshot: ContextSnapshot) =>
  snapshot.request.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")

lcmTest("the next reply sends the merged section before the parallel span, the marker at the join", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const made = yield* h.merge(h.rows[3]!.slotId)
    const built = yield* h.reply(made.slotId)
    const text = all(built)
    ascending(text, [
      "Message 2.",
      "Meanwhile, in parallel with what follows: Docks",
      "Docks one.",
      "Docks two.",
      "Message 3.",
      "Message 5.",
      "[Here “Docks” joins this chat.]"
    ])
    const section = built.request.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("Docks one.")
    )
    assert.strictEqual(section?.role, "system")
  })
)

lcmTest("the block-at-the-join layout sends the section at the join, after the destination's own", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const made = yield* h.merge(h.rows[3]!.slotId)
    yield* h.layout("join")
    const text = all(yield* h.reply(made.slotId))
    ascending(text, [
      "Message 3.",
      "Message 5.",
      "Meanwhile, elsewhere: Docks",
      "Docks one.",
      "[Here “Docks” joins this chat.]"
    ])
  })
)

lcmTest("a summary request over the join asks for one section per line and completes", (server) =>
  Effect.gen(function* () {
    const h = yield* harness(server)
    const made = yield* h.merge(h.rows[3]!.slotId)
    yield* h.append("Message 6. " + "The road ran on. ".repeat(10), made.slotId)
    const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, leafSlotId: null, limit: 500 })
    const inputs = path.entries
      .slice(0, 7)
      .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: e.version.rowVersion - 1 }))
    assert.strictEqual(inputs.at(-1)!.slotId, made.slotId)
    const [job] = yield* h.writer.EnqueueSummaries({
      userId: h.userId,
      chatId: h.chat.id,
      forkId: h.forkId,
      leafSlotId: h.rows.at(-1)!.slotId,
      chunks: [{ inputs, target: 100 }],
      requestClass: "interactive"
    })
    assert.isDefined(job)
    yield* h.runNext
    const sent = requestsTo(h.mock, "primary-model")
    assert.lengthOf(sent, 1)
    const request = texts(sent[0]!)
    assert.include(request, "one section per line")
    assert.include(request, "“Docks”")
    // In parallel: the section opens the stretch it ran beside, as the reply's context has it.
    ascending(request, ["Message 2.", "Docks one.", "Message 3.", "Message 5.", "[Here “Docks” joins this chat.]"])
    const state = yield* h.reader.GetLcmState({
      userId: h.userId,
      chatId: h.chat.id,
      forkId: h.forkId,
      leafSlotId: h.rows.at(-1)!.slotId
    })
    assert.deepStrictEqual(
      state.layer.map((s) => [s.from, s.to, s.fresh]),
      [[1, 7, true]]
    )
    const text = all(yield* h.reply(h.rows.at(-1)!.slotId))
    assert.include(text, "SUMMARY(two lines)")
    assert.notInclude(text, "Docks one.")
  })
)
