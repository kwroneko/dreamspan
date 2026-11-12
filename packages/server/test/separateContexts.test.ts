// Separate contexts per character (spec/CHARACTER-CONTEXT.md §2, §9.2 unit C3) through the real
// reader: in a separate context a character's reply leaves out what it wasn't present for, a
// narrator's and a persona's see everything, the budget fills with what it knew, a rebuild
// reproduces it, summaries covering what it missed are withheld; a shared context (the setting
// absent or "shared") is unchanged, byte for byte.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { generateReply } from "./support/generation.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const mockProvider = Effect.acquireRelease(
  Effect.promise(() =>
    startMockProvider((_request, res) =>
      sse(res, completionChunks(["The ledger says otherwise."], { prompt_tokens: 10, completion_tokens: 4 }))
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

/**
 * Mira, Wren and the user's Tobin: greeted, "The road flooded.", Mira's reply; then Wren away
 * for two messages, back for one. `setting` is the chat's context setting (absent: none).
 */
const story = (setting: "shared" | "separate" | null) =>
  Effect.gen(function* () {
    const mock = yield* mockProvider
    const api = yield* client()
    const reader = yield* Reader
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const made = yield* generateReply(api, {
      connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
      model: {},
      characters: ["Wren"],
      state: setting ? [{ key: "context.per_speaker", value: setting }] : []
    })
    const chatId = made.chat.id
    const mira = made.mira.entityId as EntityId
    const wren = made.characters[0]!.entityId as EntityId
    const tobin = made.sent.version.speakerEntityId as EntityId
    let tip = made.version.slotId as SlotId
    const event = (data: StateEventData) =>
      writer.AddStateEvent({ userId, chatId, slotId: tip, versionId: null, scope: null, data })
    const say = (speaker: EntityId, content: string, model = false) =>
      Effect.gen(function* () {
        const row = yield* writer.AppendMessage({
          userId,
          chatId,
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
        tip = row.slotId
        return row
      })
    yield* event({ key: "away.set", value: { entity: wren, away: true } })
    yield* say(tobin, "The vault code is 739.")
    yield* say(mira, "Mira hides the key under the stair.", true)
    yield* event({ key: "away.set", value: { entity: wren, away: false } })
    yield* say(tobin, "Wren walks back in.")
    /** The context of a reply by `speaker` after everything so far (its own placeholder row). */
    const contextFor = (speaker: EntityId) =>
      Effect.gen(function* () {
        const parent = tip
        const row = yield* writer.AppendMessage({
          userId,
          chatId,
          parentSlotId: parent,
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
          slotId: row.slotId,
          versionId: row.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null
        })
        return JSON.parse(built.snapshot) as ContextSnapshot
      })
    return { reader, writer, userId, chatId, mira, wren, tobin, event, say, contextFor }
  })

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const config = testConfig()
  return effect.pipe(Effect.scoped, Effect.provide(serverLayer(config)))
}

describe("separate contexts", () => {
  it.live("a character's reply leaves out what it missed; another's and a rebuild keep their own", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const wren = yield* t.contextFor(t.wren)
        const text = sentText(wren)
        assert.include(text, "The road flooded.")
        assert.include(text, "Wren walks back in.")
        assert.notInclude(text, "vault code")
        assert.notInclude(text, "hides the key")
        assert.isDefined(wren.sources?.knowers, "what was read is pinned")

        const mira = sentText(yield* t.contextFor(t.mira))
        assert.include(mira, "vault code")
        assert.include(mira, "hides the key")

        const again = yield* t.reader.RebuildContext({ userId: t.userId, snapshot: JSON.stringify(wren) })
        assert.strictEqual(again._tag, "Rebuilt")
        if (again._tag === "Rebuilt")
          assert.deepStrictEqual((JSON.parse(again.snapshot) as ContextSnapshot).request, wren.request)
      })
    )
  )

  it.live("a narrator sees everything, as does the user's persona", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const persona = sentText(yield* t.contextFor(t.tobin))
        assert.include(persona, "vault code")
        yield* t.event({ key: "cast.role", value: { entity: t.wren, role: "narrator" } })
        const narrator = sentText(yield* t.contextFor(t.wren))
        assert.include(narrator, "vault code")
        assert.include(narrator, "hides the key")
      })
    )
  )

  it.live("a shared context is unchanged: the setting absent or shared sends the same, pins nothing more", () =>
    run(
      Effect.gen(function* () {
        const absent = yield* story(null)
        const shared = yield* story("shared")
        const a = yield* absent.contextFor(absent.wren)
        const s = yield* shared.contextFor(shared.wren)
        assert.include(sentText(a), "vault code")
        assert.strictEqual(JSON.stringify(a.request), JSON.stringify(s.request))
        for (const snapshot of [a, s]) {
          assert.notProperty(snapshot.sources ?? {}, "knowers")
          assert.notProperty(snapshot.sources ?? {}, "knewThrough")
          assert.isFalse(snapshot.issues.some((i) => i.kind === "summaries_withheld"))
        }
      })
    )
  )

  it.live("a view nothing installs keeps contexts separate, and says so", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story(null)
        yield* t.event({ key: "context.per_speaker", value: "a-plugin-view" })
        const wren = yield* t.contextFor(t.wren)
        assert.notInclude(sentText(wren), "vault code")
        assert.isTrue(wren.issues.some((i) => i.kind === "context_view_missing"))
      })
    )
  )
})

describe("separate contexts and summaries", () => {
  lcmTest("summaries covering what the speaker missed are withheld, with an issue", (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 120, summarizer: () => ({ text: "SUMMARY-TEXT" }) })
      yield* h.settle
      const card = yield* h.writer.CreateEntity({
        userId: h.userId,
        kind: "card",
        label: "Wren",
        subtitle: "",
        doc: cardDoc("Wren"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const wren = card.entityId as EntityId
      const event = (data: StateEventData) =>
        h.writer.AddStateEvent({
          userId: h.userId,
          chatId: h.chat.id,
          slotId: h.rows.at(-1)!.slotId,
          versionId: null,
          scope: null,
          data
        })
      // Wren arrives after the summarized part: she knew none of it.
      yield* event({ key: "participant.join", value: { entity: wren } })
      const assemble = (setting: "shared" | "separate") =>
        Effect.gen(function* () {
          yield* event({ key: "context.per_speaker", value: setting })
          const row = yield* h.writer.AppendMessage({
            userId: h.userId,
            chatId: h.chat.id,
            parentSlotId: h.rows.at(-1)!.slotId,
            branch: true,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: wren,
              writer: "model",
              content: "",
              status: "generating",
              macroMode: "verbatim",
              origin: "generated"
            })
          })
          const built = yield* h.reader.AssembleContext({
            userId: h.userId,
            chatId: h.chat.id,
            slotId: row.slotId,
            versionId: row.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          return JSON.parse(built.snapshot) as ContextSnapshot
        })
      const shared = yield* assemble("shared")
      assert.include(sentText(shared), "SUMMARY-TEXT", "the shared context uses the summaries")
      const separate = yield* assemble("separate")
      assert.notInclude(sentText(separate), "SUMMARY-TEXT")
      assert.notInclude(sentText(separate), "The road ran on.")
      assert.isTrue(separate.issues.some((i) => i.kind === "summaries_withheld"))
    })
  )
})
