// Separate contexts per character (spec/CHARACTER-CONTEXT.md §2, §9.2 unit C3) through the real
// reader: in a separate context a character's reply leaves out what it wasn't present for, a
// narrator's and a persona's see everything, the budget fills with what it knew, a rebuild
// reproduces it, summaries covering what it missed are withheld; a shared context (the setting
// absent or "shared") is unchanged, byte for byte.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState, type StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
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

/** The utility prompts an imported ST preset has, which a test changes one of. */
const stPreset = importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!

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
const story = (setting: "shared" | "separate" | null, utility: Record<string, string> = {}) =>
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
      state: setting ? [{ key: "context.per_speaker", value: setting }] : [],
      ...(Object.keys(utility).length
        ? { presetFields: { utility_prompts: { ...stPreset.utility_prompts, ...utility } } }
        : {})
    })
    const chatId = made.chat.id
    const mira = made.mira.entityId as EntityId
    const wren = made.characters[0]!.entityId as EntityId
    // The user writes as they do in the app: no speaker recorded. Their persona is Tobin.
    const user = made.sent.version.speakerEntityId as EntityId
    const tobin = foldState(
      yield* reader.StateEventsAt({ userId, chatId, slotId: made.version.slotId, forkId: made.chat.currentForkId! })
    ).playedByMe[0] as EntityId
    // The story's line: each reply asked for below is its own branch from here, so the line
    // follows the fork its last message went to.
    let tip = made.version.slotId as SlotId
    let fork = made.chat.currentForkId! as ForkId
    const event = (data: StateEventData) =>
      writer.AddStateEvent({ userId, chatId, forkId: fork, slotId: tip, versionId: null, scope: null, data })
    const say = (speaker: EntityId, content: string, model = false) =>
      Effect.gen(function* () {
        const row = yield* writer.AppendMessage({
          userId,
          chatId,
          forkId: fork,
          parentSlotId: tip,
          branch: true,
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
        fork = row.forkId
        return row
      })
    yield* event({ key: "away.set", value: { entity: wren, away: true } })
    yield* say(user, "The vault code is 739.")
    yield* say(mira, "Mira hides the key under the stair.", true)
    yield* event({ key: "away.set", value: { entity: wren, away: false } })
    yield* say(user, "Wren walks back in.")
    /** The context of a reply by `speaker` after everything so far (its own placeholder row). */
    const contextFor = (speaker: EntityId) =>
      Effect.gen(function* () {
        const row = yield* writer.AppendMessage({
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
          slotId: row.slotId,
          versionId: row.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null,
          forkId: row.forkId
        })
        return JSON.parse(built.snapshot) as ContextSnapshot
      })
    /** Moves the line on to a message written another way (a merge's join). */
    const follow = (slotId: SlotId) =>
      Effect.sync(() => {
        tip = slotId
      })
    return { api, reader, writer, userId, chatId, mira, wren, tobin, event, say, contextFor, follow, fork: () => fork }
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

const GAP = "[Wren wasn't present for 2 messages here, in which Mira and Tobin took part.]"

describe("gap lines", () => {
  it.live("one line where Wren was away, between what she was there for, and none before she arrived", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const wren = yield* t.contextFor(t.wren)
        const text = sentText(wren)
        // §2.2's example: the stretch she missed, then what follows.
        const before = text.indexOf("The ledger says otherwise.")
        const gap = text.indexOf(GAP)
        const after = text.indexOf("Wren walks back in.")
        assert.isTrue(before >= 0 && before < gap && gap < after, text)
        assert.strictEqual(text.split("wasn't present").length - 1, 1, "one line, none for the greeting")
        // Its own system message without a name, as summaries are sent.
        const line = wren.request.messages.find((m) => m.content === GAP)
        assert.strictEqual(line?.role, "system")
        assert.notProperty(line ?? {}, "name")
        assert.isTrue(wren.pieces.some((p) => p.source.kind === "context/gap" && p.text === GAP))
        // Mira was there for everything; a shared context marks nothing.
        assert.notInclude(sentText(yield* t.contextFor(t.mira)), "wasn't present")
        const shared = yield* story("shared")
        assert.notInclude(sentText(yield* shared.contextFor(shared.wren)), "wasn't present")
      })
    )
  )

  it.live("before her own reply when the stretch runs to the end, and stable as the chat grows", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const first = yield* t.contextFor(t.wren)
        yield* t.event({ key: "away.set", value: { entity: t.wren, away: true } })
        yield* t.say(t.mira, "Mira counts the coins alone.", true)
        const later = yield* t.contextFor(t.wren)
        const text = sentText(later)
        assert.include(text, "[Wren wasn't present for 1 messages here, in which Mira took part.]")
        assert.notInclude(text, "counts the coins")
        // The earlier line is sent as it was: the prefix up to it is unchanged.
        const at = (s: ContextSnapshot) => s.request.messages.findIndex((m) => m.content === GAP)
        assert.deepStrictEqual(
          later.request.messages.slice(0, at(later) + 1),
          first.request.messages.slice(0, at(first) + 1)
        )
      })
    )
  )

  it.live("the preset's own wording, with its macros, or none", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate", {
          absent_gap_prompt: "({{char}} missed {{absentCount}}; {{absentNames}} carried on.)"
        })
        assert.include(sentText(yield* t.contextFor(t.wren)), "(Wren missed 2; Mira and Tobin carried on.)")
        const off = yield* story("separate", { absent_gap_prompt: "" })
        assert.notInclude(sentText(yield* off.contextFor(off.wren)), "wasn't present")
      })
    )
  )

  it.live("a merged-in storyline she was never in: nothing, or the join line when the preset sets one", () =>
    run(
      Effect.gen(function* () {
        const check = (utility: Record<string, string>) =>
          Effect.gen(function* () {
            const t = yield* story("separate", utility)
            // A 1:1 chat with Kai, merged in after "Wren walks back in.".
            const kai = yield* t.writer.CreateEntity({
              userId: t.userId,
              kind: "card",
              label: "Kai",
              subtitle: "",
              doc: cardDoc("Kai"),
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            })
            const docks = yield* t.writer.CreateChat({
              userId: t.userId,
              kind: "rp",
              status: "active",
              title: "Docks",
              participants: [kai.entityId as EntityId],
              greeting: null
            })
            yield* t.writer.AppendMessage({
              userId: t.userId,
              chatId: docks.id,
              parentSlotId: null,
              branch: false,
              commitDraft: null,
              version: new NewVersion({
                speakerEntityId: kai.entityId as EntityId,
                writer: "model",
                content: "Kai mends the nets at the docks.",
                status: "complete",
                macroMode: "verbatim",
                origin: "generated"
              })
            })
            const request = {
              chatId: t.chatId,
              forkId: t.fork(),
              at: null,
              source: { chatId: docks.id, forkId: docks.currentForkId! as ForkId },
              includeLeftOut: false
            }
            const seen = yield* t.reader.PreviewChatMerge({ userId: t.userId, ...request })
            const made = yield* t.writer.MergeChat({
              userId: t.userId,
              ...request,
              title: seen.sourceTitle,
              framing: null,
              digest: seen.digest
            })
            yield* t.follow(made.slotId)
            return sentText(yield* t.contextFor(t.wren))
          })
        const plain = yield* check({})
        assert.notInclude(plain, "mends the nets")
        assert.strictEqual(plain.split("wasn't present").length - 1, 1, "only the stretch she was away for")
        assert.notInclude(plain, "story continues")
        const joined = yield* check({
          absent_join_prompt: "[From here, {{char}}'s story continues together with {{mergedNames}}'s.]"
        })
        assert.include(joined, "[From here, Wren's story continues together with Kai's.]")
      })
    )
  )
})
