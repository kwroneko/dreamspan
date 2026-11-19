// Separate contexts per character (spec/CHARACTER-CONTEXT.md §2, §9.2 unit C3) through the real
// reader: in a separate context a character's reply leaves out what it wasn't present for, a
// narrator's and a persona's see everything, the budget fills with what it knew, a rebuild
// reproduces it, no summary covering what it missed is used (unit C7 reads its own); a shared context (the setting
// absent or "shared") is unchanged, byte for byte.
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId, type VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { foldState, type StateEventData } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { type ContextSnapshot, generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { editNote } from "../src/agent/tools/notes.ts"
import { copiedStoryTools } from "./support/copiedStoryTools.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
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
    const wrenRef = made.characters[0]!.ref.id
    return {
      api,
      reader,
      writer,
      userId,
      chatId,
      mira,
      wren,
      wrenRef,
      tobin,
      event,
      say,
      contextFor,
      follow,
      fork: () => fork
    }
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
  lcmTest("merged summary rows freeze the knowers of their inputs, not the source's later cast", (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 120, summarizer: () => ({ text: "SOURCE-SUMMARY" }) })
      yield* h.settle
      const made = yield* h.writer.CreateEntity({
        userId: h.userId,
        kind: "card",
        label: "Wren",
        subtitle: "",
        doc: cardDoc("Wren"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const wren = made.entityId as EntityId
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: wren } }
      })
      yield* fixtureSql(h.dataDir, [
        {
          sql: "UPDATE version_records SET cast_json = ?, presence_json = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
          params: [JSON.stringify([wren]), JSON.stringify({ away: [wren] }), h.chat.id]
        }
      ])
      const dest = yield* h.writer.CreateChat({
        userId: h.userId,
        kind: "rp",
        status: "active",
        title: "Destination",
        participants: [wren],
        greeting: null
      })
      yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId: dest.id,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: wren,
          writer: "human",
          content: "Destination begins.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const request = {
        chatId: dest.id,
        forkId: dest.currentForkId!,
        at: null,
        source: { chatId: h.chat.id, forkId: h.chat.currentForkId! },
        includeLeftOut: false
      }
      const seen = yield* h.reader.PreviewChatMerge({ userId: h.userId, ...request })
      yield* h.writer.MergeChat({
        userId: h.userId,
        ...request,
        title: seen.sourceTitle,
        framing: null,
        digest: seen.digest
      })
      const [rows] = yield* fixtureSql(
        h.dataDir,
        [{ sql: "SELECT knowers_json FROM chat_merge_messages WHERE kind = 'summary'" }],
        { readOnly: true }
      )
      assert.isAbove(rows!.length, 0, "fixture includes frozen summaries")
      assert.isTrue(
        rows!.every((r) => r.knowers_json === "[]"),
        JSON.stringify(rows)
      )
    })
  )

  lcmTest("a stale summary cannot reveal the away version after selecting a present swipe", (server) =>
    Effect.gen(function* () {
      const h = yield* lcmHarness(server, { messages: 120, summarizer: () => ({ text: "SECRET-SUMMARY" }) })
      yield* h.settle
      const made = yield* h.writer.CreateEntity({
        userId: h.userId,
        kind: "card",
        label: "Wren",
        subtitle: "",
        doc: cardDoc("Wren"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      const wren = made.entityId as EntityId
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "participant.join", value: { entity: wren } }
      })
      yield* h.writer.AddStateEvent({
        userId: h.userId,
        chatId: h.chat.id,
        slotId: null,
        versionId: null,
        scope: null,
        data: { key: "context.per_speaker", value: "separate" }
      })
      yield* fixtureSql(server.config.dataDir, [
        {
          sql: "UPDATE version_records SET cast_json = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
          params: [JSON.stringify([wren]), h.chat.id]
        },
        {
          sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
          params: [JSON.stringify({ away: [wren] }), h.rows[0]!.version.id]
        }
      ])
      yield* h.writer.AddVersion({
        userId: h.userId,
        slotId: h.rows[0]!.slotId,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "Public replacement.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        }),
        select: true,
        commitDraft: null
      })
      const row = yield* h.writer.AppendMessage({
        userId: h.userId,
        chatId: h.chat.id,
        parentSlotId: h.rows.at(-1)!.slotId,
        branch: false,
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
      const snapshot = JSON.parse(built.snapshot) as ContextSnapshot
      assert.notInclude(sentText(snapshot), "SECRET-SUMMARY")
      // Unit C7: the view's layer leaves out the stale summary written from the away version,
      // so nothing needs withholding.
      assert.isFalse(snapshot.issues.some((i) => i.kind === "summaries_withheld"))
    })
  )

  lcmTest("a separate context reads no shared summary past where it diverged", (server) =>
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
      // Unit C7: Wren knew none of it, so her layer holds no shared summary and none of her own yet.
      assert.isFalse(separate.issues.some((i) => i.kind === "summaries_withheld"))
      assert.isFalse(separate.pieces.some((p) => p.source.kind === "summary"))
    })
  )
})

const GAP = "[Wren wasn't present for 2 messages here, in which Mira and Tobin took part.]"

describe("gap lines", () => {
  it.live("a source cast member who was away cannot read the merge's whole transcript", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const source = yield* t.writer.CreateChat({
          userId: t.userId,
          kind: "rp",
          status: "active",
          title: "Private docks",
          participants: [t.mira, t.wren],
          greeting: null
        })
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: source.id,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.wren, away: true } }
        })
        yield* t.writer.AppendMessage({
          userId: t.userId,
          chatId: source.id,
          parentSlotId: null,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: t.mira,
            writer: "human",
            content: "MERGED-SECRET",
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
        const request = {
          chatId: t.chatId,
          forkId: t.fork(),
          at: null,
          source: { chatId: source.id, forkId: source.currentForkId! },
          includeLeftOut: false
        }
        const seen = yield* t.reader.PreviewChatMerge({ userId: t.userId, ...request })
        const joined = yield* t.writer.MergeChat({
          userId: t.userId,
          ...request,
          title: seen.sourceTitle,
          framing: null,
          digest: seen.digest
        })
        yield* t.follow(joined.slotId)
        assert.notInclude(sentText(yield* t.contextFor(t.wren)), "MERGED-SECRET")
        assert.include(sentText(yield* t.contextFor(t.mira)), "MERGED-SECRET")
      })
    )
  )

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

/** A tool run as the reply whose context `snapshot` is, reading as its viewer. */
const tools = (t: Effect.Success<ReturnType<typeof story>>, snapshot: ContextSnapshot, forcePath = false) => {
  const leaf = snapshot.inputs.leafSlotId as SlotId
  const context: ToolContext = {
    userId: t.userId,
    chatId: t.chatId,
    forkId: t.fork(),
    slotId: leaf,
    versionId: "unused" as VersionId,
    leafSlotId: leaf,
    viewers: generationOf(snapshot).viewers,
    speaker: snapshot.inputs.speaker,
    rolloutId: "test",
    toolCallId: "test",
    cache: new Map(),
    reader: forcePath
      ? { ...t.reader, SearchChat: (() => Effect.succeed(null)) as typeof t.reader.SearchChat }
      : t.reader,
    writer: t.writer
  }
  return (id: string, args: object) =>
    Effect.gen(function* () {
      const copies = yield* copiedStoryTools
      const out = yield* [...copies, editNote].find((tool) => tool.id === id)!.execute(context, args as never)
      return out.text
    })
}

describe("merged chats per viewer (unit C6)", () => {
  type Story = Effect.Success<ReturnType<typeof story>>
  const card = (t: Story, name: string) =>
    Effect.map(
      t.writer.CreateEntity({
        userId: t.userId,
        kind: "card",
        label: name,
        subtitle: "",
        doc: cardDoc(name),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      }),
      (made) => made.entityId as EntityId
    )
  /** A chat of `participants` with these lines, `away` marked before the line it's on, merged in at the tip. */
  const mergeIn = (
    t: Story,
    title: string,
    participants: ReadonlyArray<EntityId>,
    lines: ReadonlyArray<{ speaker: EntityId; content: string; away?: EntityId }>
  ) =>
    Effect.gen(function* () {
      const source = yield* t.writer.CreateChat({
        userId: t.userId,
        kind: "rp",
        status: "active",
        title,
        participants: [...participants],
        greeting: null
      })
      let parent: SlotId | null = null
      for (const line of lines) {
        if (line.away)
          yield* t.writer.AddStateEvent({
            userId: t.userId,
            chatId: source.id,
            slotId: parent,
            versionId: null,
            scope: null,
            data: { key: "away.set", value: { entity: line.away, away: true } }
          })
        const row: { readonly slotId: SlotId } = yield* t.writer.AppendMessage({
          userId: t.userId,
          chatId: source.id,
          parentSlotId: parent,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: line.speaker,
            writer: "model",
            content: line.content,
            status: "complete",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        parent = row.slotId
      }
      const request = {
        chatId: t.chatId,
        forkId: t.fork(),
        at: null,
        source: { chatId: source.id, forkId: source.currentForkId! as ForkId },
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
      return made
    })

  it.live("a character sees the merged lines it was there for, and a shared context the whole join", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        // Wren and Mira at the docks; Wren leaves before Mira's second line.
        const merged = yield* mergeIn(
          t,
          "Private docks",
          [t.mira, t.wren],
          [
            { speaker: t.mira, content: "DOCKS-SHARED: the tide turns." },
            { speaker: t.mira, content: "MERGED-SECRET: the crate is hollow.", away: t.wren }
          ]
        )
        const wren = yield* t.contextFor(t.wren)
        const forWren = sentText(wren)
        assert.include(forWren, "Mira: DOCKS-SHARED: the tide turns.")
        assert.notInclude(forWren, "MERGED-SECRET")
        // She knew this chat's own messages beside it: still a section, under its heading.
        assert.include(forWren, "Meanwhile")
        assert.include(forWren, "[Here “Private docks” joins this chat.]")
        const forMira = sentText(yield* t.contextFor(t.mira))
        assert.include(forMira, "DOCKS-SHARED")
        assert.include(forMira, "MERGED-SECRET")
        // A rebuild of Wren's context sends the same.
        const again = yield* t.reader.RebuildContext({ userId: t.userId, snapshot: JSON.stringify(wren) })
        assert.strictEqual(again._tag, "Rebuilt")
        if (again._tag === "Rebuilt")
          assert.deepStrictEqual((JSON.parse(again.snapshot) as ContextSnapshot).request, wren.request)
        const read = tools(t, wren)
        assert.include(yield* read("read_messages", { from: 1, count: 20 }), "DOCKS-SHARED")
        assert.include(yield* read("search_chat", { query: "DOCKS-SHARED" }), "the tide turns")
        assert.notInclude(yield* read("search_chat", { query: "MERGED-SECRET" }), "crate")
        const join = (yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          leafSlotId: merged.slotId,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries[0]!.version
        yield* t.writer.AmendVersion({
          userId: t.userId,
          versionId: join.id,
          expectedRowVersion: join.rowVersion,
          content: "Mira: DOCKS-SHARED: the tide ebbs.\n\nMira: MERGED-SECRET: the crate is hollow.",
          forkId: t.fork()
        })
        const edited = yield* t.contextFor(t.wren)
        assert.include(sentText(edited), "the tide ebbs.")
        assert.notInclude(sentText(edited), "crate")
        assert.include(yield* tools(t, edited)("search_chat", { query: "ebbs" }), "the tide ebbs")
        // One shared context sends the join as written.
        yield* t.event({ key: "context.per_speaker", value: "shared" })
        const shared = sentText(yield* t.contextFor(t.wren))
        assert.include(shared, "DOCKS-SHARED")
        assert.include(shared, "MERGED-SECRET")
      })
    )
  )

  it.live("a joined own line preserves the source request's history prefix", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const base = (yield* t.contextFor(t.wren)).inputs.leafSlotId as SlotId
        const { fork: source } = yield* t.writer.CreateFork({
          userId: t.userId,
          chatId: t.chatId,
          fromForkId: t.fork(),
          atSlotId: base
        })
        const append = (
          forkId: ForkId,
          parentSlotId: SlotId,
          content: string,
          status: "complete" | "generating" = "complete"
        ) =>
          t.writer.AppendMessage({
            userId: t.userId,
            chatId: t.chatId,
            forkId,
            parentSlotId,
            branch: false,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: t.wren,
              writer: "model",
              content,
              status,
              macroMode: "verbatim",
              origin: "generated"
            })
          })
        const first = yield* append(source.id, base, "SOURCE-PREFIX: Wren mends the nets.")
        const last = yield* append(source.id, first.slotId, "SOURCE-PREFIX: Wren counts the boats.")
        const pending = yield* append(source.id, last.slotId, "", "generating")
        const sourceBuilt = yield* t.reader.AssembleContext({
          userId: t.userId,
          chatId: t.chatId,
          forkId: source.id,
          slotId: pending.slotId,
          versionId: pending.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null
        })
        const before = JSON.parse(sourceBuilt.snapshot) as ContextSnapshot
        yield* t.event({ key: "away.set", value: { entity: t.wren, away: true } })
        const destStart = yield* t.say(t.mira, "DESTINATION-SECRET: the chest is empty.")
        yield* t.say(t.mira, "DESTINATION-SECRET: Mira waits.")
        const request = {
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          at: null,
          start: destStart.slotId,
          source: { chatId: t.chatId, forkId: source.id },
          includeLeftOut: false
        }
        const preview = yield* t.reader.PreviewChatMerge(request)
        const joined = yield* t.writer.MergeChat({
          ...request,
          title: preview.sourceTitle,
          framing: null,
          digest: preview.digest
        })
        yield* t.follow(joined.slotId)
        yield* t.event({ key: "away.set", value: { entity: t.wren, away: false } })
        const after = yield* t.contextFor(t.wren)
        const through = before.request.messages.findIndex(
          (m) => typeof m.content === "string" && m.content.includes("Wren counts the boats.")
        )
        assert.isAbove(through, 0)
        assert.deepStrictEqual(
          after.request.messages.slice(0, through + 1),
          before.request.messages.slice(0, through + 1)
        )
        assert.notInclude(sentText(after), "DESTINATION-SECRET")
      })
    )
  )

  it.live("a character new to this chat reads its own merged line as its history, without a heading", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const kai = yield* card(t, "Kai")
        yield* mergeIn(
          t,
          "Docks",
          [kai],
          [
            { speaker: kai, content: "Kai mends the nets at the docks." },
            { speaker: kai, content: "Kai counts the boats coming in." }
          ]
        )
        const built = yield* t.contextFor(kai)
        const forKai = sentText(built)
        // Nothing of this chat before the join, nor a line for it: Kai was never in it.
        assert.notInclude(forKai, "The vault code is 739.")
        assert.notInclude(forKai, "wasn't present")
        assert.notInclude(forKai, "Meanwhile")
        const nets = built.request.messages.findIndex(
          (m) => typeof m.content === "string" && m.content.includes("Kai mends the nets at the docks.")
        )
        const boats = built.request.messages.findIndex(
          (m) => typeof m.content === "string" && m.content.includes("Kai counts the boats coming in.")
        )
        assert.isTrue(nets >= 0 && boats === nets + 1, JSON.stringify(built.request.messages))
        assert.strictEqual(built.request.messages[nets]!.role, "assistant")
        const marker = built.request.messages.findIndex((m) => m.content === "[Here “Docks” joins this chat.]")
        assert.strictEqual(marker, boats + 1)
        // Wren was never in it: nothing of it (unit C4's rule).
        assert.notInclude(sentText(yield* t.contextFor(t.wren)), "mends the nets")
      })
    )
  )
})

describe("the agent's read tools in a separate context", () => {
  it.live("set_presence refuses a narrator in either direction", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        yield* t.event({ key: "cast.role", value: { entity: t.wren, role: "narrator" } })
        const tool = tools(t, yield* t.contextFor(t.wren))
        for (const present of [true, false])
          assert.include(yield* tool("set_presence", { character: "Wren", present }), "is the narrator")
      })
    )
  )

  it.live("search_chat never finds what the viewer missed; read_messages skips it, numbering kept", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const forWren = yield* t.contextFor(t.wren)
        assert.strictEqual(forWren.inputs.viewer, t.wren)
        const wren = tools(t, forWren)
        const mira = tools(t, yield* t.contextFor(t.mira))

        assert.include(yield* mira("search_chat", { query: "vault" }), "vault code")
        assert.include(yield* wren("search_chat", { query: "vault" }), "No earlier messages match")
        assert.include(yield* wren("search_chat", { query: "walks" }), "Wren walks back in.")

        const numbers = (text: string) => [...text.matchAll(/^Message (\d+),/gm)].map((m) => Number(m[1]))
        const read = yield* wren("read_messages", { from: 1, count: 20 })
        assert.notInclude(read, "vault code")
        assert.notInclude(read, "hides the key")
        assert.include(read, "Wren walks back in.")
        // What she missed is gone (Mira's greeting too: Wren joined after it, as her reply's
        // context has it); every other message keeps its number.
        assert.deepStrictEqual(numbers(yield* mira("read_messages", { from: 1, count: 20 })), [1, 2, 3, 4, 5, 6])
        assert.deepStrictEqual(numbers(read), [2, 3, 6])
        assert.notInclude(sentText(forWren), "Late again")
        assert.include(yield* wren("read_messages", { from: 4, count: 1 }), "Wren walks back in.")
        const fallback = tools(t, forWren, true)
        for (const query of ["vault", "walks", "flooded"])
          assert.strictEqual(yield* fallback("search_chat", { query }), yield* wren("search_chat", { query }))
      })
    )
  )

  it.live("inserted messages use the same presence and causal limits in the fallback tools", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const leaf = (yield* t.contextFor(t.wren)).inputs.leafSlotId as SlotId
        const path = yield* t.reader.ReadPath({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          leafSlotId: leaf,
          range: { _tag: "Bottom" },
          limit: 20
        })
        const anchor = path.entries.find((e) => e.version.content.includes("vault code"))!
        const inserted = yield* t.writer.InsertMessage({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          anchorSlotId: anchor.slotId,
          expectedRowVersion: anchor.rowVersion,
          body: { _tag: "Write", speaker: t.mira, content: "INSERTED-SECRET: the hidden cove." }
        })
        const wren = tools(t, yield* t.contextFor(t.wren))
        const mira = tools(t, yield* t.contextFor(t.mira))
        assert.include(yield* mira("search_chat", { query: "hidden cove" }), "INSERTED-SECRET")
        assert.notInclude(yield* wren("search_chat", { query: "hidden cove" }), "INSERTED-SECRET")
        assert.notInclude(yield* wren("read_messages", { from: 1, count: 20 }), "INSERTED-SECRET")
        const beforeInsert = yield* t.contextFor(t.mira)
        const early = { ...beforeInsert, inputs: { ...beforeInsert.inputs, leafSlotId: anchor.slotId } }
        assert.notInclude(
          yield* tools(t, early)("search_chat", { query: "hidden cove" }),
          "INSERTED-SECRET",
          "an inserted successor cannot be read before its position"
        )
        yield* t.writer
          .AddStateEvent({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.fork(),
            slotId: inserted.slotId,
            versionId: null,
            scope: null,
            data: { key: "away.set", value: { entity: t.wren, away: true, source: "decision" } }
          })
          .pipe(
            Effect.flatMap((mark) =>
              t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: mark.id })
            )
          )
        assert.include(
          sentText(yield* t.contextFor(t.wren)),
          "hides the key",
          "correction follows display order after an inserted mark"
        )
        assert.notInclude(
          sentText(yield* t.contextFor(t.wren)),
          "vault code",
          "messages before the inserted mark remain unknown"
        )
      })
    )
  )

  it.live("a card that replaced the viewer reads with the viewer's knowledge", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const next = yield* t.writer.ForkCard({
          userId: t.userId,
          refId: t.wrenRef,
          name: "Wren later",
          nickname: "Wren",
          characterVersion: "2"
        })
        yield* t.event({ key: "card.swap", value: { entity: next.entityId as EntityId, replaces: t.wren } })
        const snapshot = yield* t.contextFor(next.entityId as EntityId)
        assert.deepStrictEqual([...snapshot.inputs.viewerAliases!].sort(), [t.wren, next.entityId].sort())
        const later = tools(t, snapshot)
        assert.include(yield* later("search_chat", { query: "walks" }), "Wren walks back in.")
        assert.include(yield* later("search_chat", { query: "vault" }), "No earlier messages match")
        const read = yield* later("read_messages", { from: 1, count: 20 })
        assert.include(read, "The road flooded.")
        assert.notInclude(read, "hides the key")
      })
    )
  )

  it.live("a shared context's tools read everything; list_notes leaves out other characters' own-turn notes", () =>
    run(
      Effect.gen(function* () {
        const shared = yield* story("shared")
        const forShared = yield* shared.contextFor(shared.wren)
        assert.notProperty(forShared.inputs, "viewer")
        assert.include(yield* tools(shared, forShared)("search_chat", { query: "vault" }), "vault code")

        yield* shared.writer.CreateEntity({
          userId: shared.userId,
          kind: "note",
          label: "Mira private card note",
          subtitle: "",
          doc: {
            schema_version: 1,
            title: "Mira private card note",
            content: "PRIVATE-NOTE-TEXT",
            owner: { card: shared.mira },
            condition: { when: "own_turn" },
            placement: { mode: "section", section: "own_turn" },
            exportable: true,
            agent_editable: true
          },
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        yield* shared.event({ key: "cast.role", value: { entity: shared.wren, role: "narrator" } })
        for (const speaker of [shared.wren, shared.tobin]) {
          const sharedTools = tools(shared, yield* shared.contextFor(speaker))
          assert.notInclude(yield* sharedTools("list_notes", {}), "Mira private card note")
          assert.include(
            yield* sharedTools("edit_note", {
              note: "Mira private card note",
              find: "PRIVATE-NOTE-TEXT",
              replace: "x"
            }),
            "No note is called"
          )
          assert.include(
            yield* sharedTools("switch_note", { note: "Mira private card note", on: true }),
            "No note is called"
          )
        }
        assert.include(
          yield* tools(shared, yield* shared.contextFor(shared.mira))("list_notes", {}),
          "Mira private card note"
        )

        const t = yield* story("separate")
        const note = (title: string, condition: object | null) =>
          Effect.gen(function* () {
            const made = yield* t.writer.CreateEntity({
              userId: t.userId,
              kind: "note",
              label: title,
              subtitle: "",
              doc: {
                schema_version: 1,
                title,
                content: `${title} text.`,
                owner: { chat: t.chatId },
                placement: { mode: "tail", role: "system" },
                exportable: false,
                ...(condition ? { condition } : {})
              } as never,
              schemaVersion: 1,
              origin: "user",
              sourcePath: null
            })
            yield* t.event({ key: "note.activate", value: { note: made.entityId } })
          })
        yield* note("Mira's secret", { when: "turn", cards: [t.mira] })
        yield* note("Wren's secret", { when: "turn", cards: [t.wren] })
        yield* note("While Mira is here", { when: "not_muted", cards: [t.mira] })
        yield* note("Weather", null)
        const forWren = yield* tools(t, yield* t.contextFor(t.wren))("list_notes", {})
        assert.include(forWren, "Wren's secret")
        assert.include(forWren, "While Mira is here")
        assert.include(forWren, "Weather")
        assert.notInclude(forWren, "Mira's secret")
        const restricted = tools(t, yield* t.contextFor(t.wren))
        assert.include(
          yield* restricted("edit_note", { note: "Mira's secret", find: "unknown passage", replace: "x" }),
          "No note is called"
        )
        assert.include(yield* restricted("switch_note", { note: "Mira's secret", on: false }), "No note is called")

        assert.include(yield* tools(t, yield* t.contextFor(t.mira))("list_notes", {}), "Mira's secret")
      })
    )
  )
})

describe("Undo of a scene check's away mark (unit C9)", () => {
  it.live("a correction covers inherited messages only in its viewing branch and can be reversed", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const mark = yield* t.event({ key: "away.set", value: { entity: t.wren, away: true, source: "decision" } })
        const last = yield* t.say(t.mira, "INHERITED-SECRET")
        const { fork: peer } = yield* t.api.CreateFork({
          chatId: t.chatId,
          fromForkId: t.fork(),
          atSlotId: last.slotId
        })
        const corrected = yield* t.writer.CorrectPresence({
          userId: t.userId,
          chatId: t.chatId,
          forkId: peer.id,
          eventId: mark.id
        })
        assert.isNotNull(corrected)
        const peerContext = Effect.gen(function* () {
          const row = yield* t.writer.AppendMessage({
            userId: t.userId,
            chatId: t.chatId,
            forkId: peer.id,
            parentSlotId: last.slotId,
            branch: true,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: t.wren,
              writer: "model",
              content: "",
              status: "generating",
              macroMode: "verbatim",
              origin: "generated"
            })
          })
          const built = yield* t.reader.AssembleContext({
            userId: t.userId,
            chatId: t.chatId,
            forkId: row.forkId,
            slotId: row.slotId,
            versionId: row.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          return sentText(JSON.parse(built.snapshot) as ContextSnapshot)
        })
        assert.include(yield* peerContext, "INHERITED-SECRET")
        const original = sentText(yield* t.contextFor(t.wren))
        assert.notInclude(original, "INHERITED-SECRET", "Undo on the peer must leave the original branch unchanged")
        const history = yield* t.reader.ListHistoryEdits({ userId: t.userId, chatId: t.chatId, forkId: peer.id })
        const record = history.find((edit) => edit.title === "Correct scene check")!
        assert.strictEqual(
          (yield* t.writer.UndoHistoryEdit({
            userId: t.userId,
            chatId: t.chatId,
            forkId: peer.id,
            changesetId: record.id
          })).undone,
          1
        )
        assert.notInclude(yield* peerContext, "INHERITED-SECRET")
      })
    )
  )

  it.live("a decision attached to an unselected swipe cannot be corrected", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const at = yield* t.say(t.mira, "Wren walks out.", true)
        const mark = yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          slotId: at.slotId,
          versionId: at.version.id,
          scope: null,
          data: { key: "away.set", value: { entity: t.wren, away: true, source: "decision" } }
        })
        yield* t.say(t.mira, "AWAY-UNDER-OLD-SWIPE")
        yield* t.writer.AddVersion({
          userId: t.userId,
          slotId: at.slotId,
          forkId: t.fork(),
          select: true,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: t.mira,
            writer: "human",
            content: "Wren stays.",
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
        assert.isNull(
          yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: mark.id })
        )
      })
    )
  )

  it.live("another branch's later away event does not stop correction on this branch", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        const mark = yield* t.event({ key: "away.set", value: { entity: t.wren, away: true, source: "decision" } })
        const first = yield* t.say(t.mira, "FIRST-CORRECTED")
        const { fork: peer } = yield* t.api.CreateFork({
          chatId: t.chatId,
          fromForkId: t.fork(),
          atSlotId: first.slotId
        })
        yield* t.writer.AddStateEvent({
          userId: t.userId,
          chatId: t.chatId,
          forkId: peer.id,
          slotId: first.slotId,
          versionId: null,
          scope: null,
          data: { key: "away.set", value: { entity: t.wren, away: true } }
        })
        yield* t.say(t.mira, "SECOND-CORRECTED")
        yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: mark.id })
        assert.include(sentText(yield* t.contextFor(t.wren)), "SECOND-CORRECTED")
      })
    )
  )

  it.live("the user's word replaces the decision's, and what was written since counts her present", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        // The scene check judged that Wren left here.
        const mark = yield* t.event({ key: "away.set", value: { entity: t.wren, away: true, source: "decision" } })
        const said = yield* t.say(t.tobin, "The password is heron.")
        const last = yield* t.say(t.mira, "Mira repeats it twice.", true)
        assert.notInclude(sentText(yield* t.contextFor(t.wren)), "heron")
        const { fork: peer } = yield* t.api.CreateFork({
          chatId: t.chatId,
          fromForkId: t.fork(),
          atSlotId: last.slotId
        })
        const awayIn = (forkId: ForkId) =>
          Effect.map(
            t.reader.StateEventsAt({ userId: t.userId, chatId: t.chatId, slotId: last.slotId, forkId }),
            (events) => foldState(events).away
          )
        assert.include(yield* awayIn(peer.id), t.wren)

        // Only a live mark of the scene check can be undone this way.
        const user = yield* t.event({ key: "away.set", value: { entity: t.mira, away: true } })
        assert.isNull(
          yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: user.id })
        )
        yield* t.event({ key: "away.set", value: { entity: t.mira, away: false } })

        const undone = yield* t.writer.CorrectPresence({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          eventId: mark.id
        })
        assert.isNotNull(undone)
        // The two messages written since, and the reply Wren was asked for after them.
        assert.includeMembers([...undone!.corrected], [said.version.id, last.version.id])
        assert.lengthOf(undone!.corrected, 3)
        assert.include(sentText(yield* t.contextFor(t.wren)), "The password is heron.")
        assert.include(sentText(yield* t.contextFor(t.wren)), "Mira repeats it twice.")
        const correctedRequest = yield* t.contextFor(t.wren)
        for (const forcePath of [false, true]) {
          const read = tools(t, correctedRequest, forcePath)
          assert.include(yield* read("search_chat", { query: "heron" }), "The password is heron.")
          assert.include(yield* read("read_messages", { from: 1, count: 30 }), "The password is heron.")
        }
        const peerSearch = yield* t.reader.SearchChat({
          userId: t.userId,
          chatId: t.chatId,
          forkId: peer.id,
          leafSlotId: last.slotId,
          tokens: ["heron"],
          before: null,
          limit: 10,
          viewers: [t.wren]
        })
        assert.deepStrictEqual(peerSearch, [], "the untouched branch's SQL search keeps the secret hidden")
        // What she was away for before the mark stays unknown to her.
        assert.notInclude(sentText(correctedRequest), "vault code")
        // Only the branch in this tab is corrected.
        assert.notInclude(yield* awayIn(t.fork()), t.wren)
        assert.include(yield* awayIn(peer.id), t.wren)
        const events = yield* t.reader.StateEventsAt({
          userId: t.userId,
          chatId: t.chatId,
          slotId: last.slotId,
          forkId: t.fork()
        })
        assert.deepInclude(
          events.map((e) => e.data),
          { key: "away.set", value: { entity: t.wren, away: false } },
          "the user's own event"
        )
        // Undone once: the mark no longer applies there, so there is nothing to undo.
        const again = yield* t.writer.CorrectPresence({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          eventId: mark.id
        })
        assert.isNull(again)
        assert.isNull(
          yield* t.writer.CorrectPresence({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.fork(),
            eventId: undone!.eventId
          }),
          "the compensating present event is not another decision"
        )
        const history = yield* t.reader.ListHistoryEdits({ userId: t.userId, chatId: t.chatId, forkId: t.fork() })
        const correction = history.find((edit) => edit.title === "Correct scene check")!
        assert.isDefined(correction)
        assert.include(correction.items[0]!.before, '"source":"decision"', "History retains the original mark")
        assert.include(correction.items[0]!.after, '"away":false')
        const reverted = yield* t.writer.UndoHistoryEdit({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          changesetId: correction.id
        })
        assert.strictEqual(reverted.undone, 1)
        assert.include(yield* awayIn(peer.id), t.wren, "History Undo leaves the other branch alone")
        assert.notInclude(sentText(yield* t.contextFor(t.wren)), "The password is heron.")
      })
    )
  )

  it.live("undoing the scene check's 'back' keeps her away: what was written since leaves her context again", () =>
    run(
      Effect.gen(function* () {
        const t = yield* story("separate")
        yield* t.event({ key: "away.set", value: { entity: t.wren, away: true, source: "decision" } })
        yield* t.say(t.tobin, "WHILE-AWAY")
        // The scene check judged that Wren came back here.
        const back = yield* t.event({ key: "away.set", value: { entity: t.wren, away: false, source: "decision" } })
        const first = yield* t.say(t.tobin, "AFTER-BACK-ONE")
        const last = yield* t.say(t.mira, "AFTER-BACK-TWO")
        const { fork: peer } = yield* t.api.CreateFork({
          chatId: t.chatId,
          fromForkId: t.fork(),
          atSlotId: last.slotId
        })
        const wrens = Effect.map(t.contextFor(t.wren), sentText)
        assert.include(yield* wrens, "AFTER-BACK-ONE")
        assert.notInclude(yield* wrens, "WHILE-AWAY")
        const awayIn = (forkId: ForkId) =>
          Effect.map(
            t.reader.StateEventsAt({ userId: t.userId, chatId: t.chatId, slotId: last.slotId, forkId }),
            (events) => foldState(events).away
          )
        assert.notInclude((yield* awayIn(t.fork())) ?? [], t.wren)

        // Only a scene check's mark can be undone: the user's own "back" is refused, both ways.
        const user = yield* t.event({ key: "away.set", value: { entity: t.mira, away: false } })
        assert.isNull(
          yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: user.id })
        )

        const undone = yield* t.writer.CorrectPresence({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          eventId: back.id
        })
        assert.isNotNull(undone)
        assert.includeMembers([...undone!.corrected], [first.version.id, last.version.id])
        assert.notInclude(yield* wrens, "AFTER-BACK-ONE")
        assert.notInclude(yield* wrens, "AFTER-BACK-TWO")
        assert.notInclude(yield* wrens, "WHILE-AWAY")
        assert.include(yield* awayIn(t.fork()), t.wren)
        assert.notInclude(yield* awayIn(peer.id), t.wren)
        const events = yield* t.reader.StateEventsAt({
          userId: t.userId,
          chatId: t.chatId,
          slotId: last.slotId,
          forkId: t.fork()
        })
        assert.deepInclude(
          events.map((e) => e.data),
          { key: "away.set", value: { entity: t.wren, away: true } },
          "the user's own event"
        )
        // Undone once: the mark no longer applies, and the compensating event is no scene check's.
        assert.isNull(
          yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: back.id })
        )
        assert.isNull(
          yield* t.writer.CorrectPresence({
            userId: t.userId,
            chatId: t.chatId,
            forkId: t.fork(),
            eventId: undone!.eventId
          })
        )
        // History keeps both and can take the correction back: she is back, and sees them again.
        const history = yield* t.reader.ListHistoryEdits({ userId: t.userId, chatId: t.chatId, forkId: t.fork() })
        const correction = history.find((edit) => edit.title === "Correct scene check")!
        assert.include(correction.items[0]!.before, '"away":false')
        assert.include(correction.items[0]!.after, '"away":true')
        const reverted = yield* t.writer.UndoHistoryEdit({
          userId: t.userId,
          chatId: t.chatId,
          forkId: t.fork(),
          changesetId: correction.id
        })
        assert.strictEqual(reverted.undone, 1)
        assert.include(yield* wrens, "AFTER-BACK-ONE")
        assert.include(yield* wrens, "AFTER-BACK-TWO")
        assert.notInclude(yield* wrens, "WHILE-AWAY")
        assert.notInclude((yield* awayIn(peer.id)) ?? [], t.wren)
      })
    )
  )
})

it.live("peer-authored handwritten swipes retain their later independent away mark", () =>
  run(
    Effect.gen(function* () {
      const t = yield* story("separate")
      const base = (yield* t.contextFor(t.wren)).inputs.leafSlotId as SlotId
      const mark = yield* t.event({
        key: "away.set",
        value: { entity: t.wren, away: true, source: "decision" }
      })
      const original = yield* t.say(t.mira, "Wrong-scene-check version.")
      const { fork: peer } = yield* t.writer.CreateFork({
        userId: t.userId,
        chatId: t.chatId,
        fromForkId: t.fork(),
        atSlotId: original.slotId
      })
      yield* t.writer.AddStateEvent({
        userId: t.userId,
        chatId: t.chatId,
        forkId: peer.id,
        slotId: base,
        versionId: null,
        scope: null,
        data: { key: "away.set", value: { entity: t.wren, away: true } }
      })
      const own = yield* t.writer.AddVersion({
        userId: t.userId,
        slotId: original.slotId,
        forkId: peer.id,
        select: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: t.mira,
          writer: "human",
          content: "Peer-only private alternative.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      const before = yield* t.reader.KnowersOf({
        userId: t.userId,
        chatId: t.chatId,
        versionIds: [own.id],
        forkId: peer.id
      })
      assert.notInclude(before[0]!.knowers!, t.wren)
      yield* t.writer.CorrectPresence({
        userId: t.userId,
        chatId: t.chatId,
        forkId: t.fork(),
        eventId: mark.id
      })
      const after = yield* t.reader.KnowersOf({
        userId: t.userId,
        chatId: t.chatId,
        versionIds: [original.version.id, own.id],
        forkId: peer.id
      })
      assert.notInclude(after[0]!.knowers!, t.wren, "the peer retains the shared version's original knowledge")
      assert.notInclude(after[1]!.knowers!, t.wren, "the peer keeps its own away mark")
      const main = yield* t.reader.KnowersOf({
        userId: t.userId,
        chatId: t.chatId,
        versionIds: [original.version.id, own.id],
        forkId: t.fork()
      })
      assert.include(main[0]!.knowers!, t.wren)
      assert.include(main[1]!.knowers!, t.wren, "the correction applies to swipes shown in the corrected branch")
    })
  )
)

it.live("Undo of a wrong return and History's inverse inherit only into later children of that branch", () =>
  run(
    Effect.gen(function* () {
      const t = yield* story("separate")
      yield* t.event({ key: "away.set", value: { entity: t.wren, away: true, source: "decision" } })
      yield* t.say(t.mira, "Still at the docks.")
      const back = yield* t.event({ key: "away.set", value: { entity: t.wren, away: false, source: "decision" } })
      const secret = yield* t.say(t.mira, "FALSE-RETURN-SECRET")
      const root = t.fork()
      const peer = (yield* t.api.CreateFork({ chatId: t.chatId, fromForkId: root, atSlotId: secret.slotId })).fork.id
      const known = (forkId: ForkId) =>
        Effect.map(
          t.reader.KnowersOf({ userId: t.userId, chatId: t.chatId, forkId, versionIds: [secret.version.id] }),
          (rows) => rows[0]!.knowers!.includes(t.wren)
        )
      assert.isTrue(yield* known(root))
      assert.isTrue(yield* known(peer))
      yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: root, eventId: back.id })
      assert.isFalse(yield* known(root))
      assert.isTrue(yield* known(peer))
      for (const forkId of [root, peer]) {
        const matches = yield* t.reader.SearchChat({
          userId: t.userId,
          chatId: t.chatId,
          forkId,
          leafSlotId: secret.slotId,
          tokens: ["return"],
          before: null,
          limit: 10,
          viewers: [t.wren]
        })
        assert.strictEqual(
          matches!.some((m) => m.content.includes("FALSE-RETURN-SECRET")),
          forkId === peer
        )
      }
      const correctedChild = (yield* t.api.CreateFork({ chatId: t.chatId, fromForkId: root, atSlotId: secret.slotId }))
        .fork.id
      const peerChild = (yield* t.api.CreateFork({ chatId: t.chatId, fromForkId: peer, atSlotId: secret.slotId })).fork
        .id
      assert.isFalse(yield* known(correctedChild))
      assert.isTrue(yield* known(peerChild))
      const history = yield* t.reader.ListHistoryEdits({ userId: t.userId, chatId: t.chatId, forkId: correctedChild })
      const record = history.find((r) => r.title === "Correct scene check")!
      assert.isDefined(record)
      const undone = yield* t.writer.UndoHistoryEdit({
        userId: t.userId,
        chatId: t.chatId,
        forkId: correctedChild,
        changesetId: record.id
      })
      assert.strictEqual(undone.undone, 1)
      assert.isTrue(yield* known(correctedChild))
      assert.isFalse(yield* known(root), "the inverse on a child does not undo its parent's correction")
      assert.isTrue(yield* known(peer))
    })
  )
)

it.live("resuming a shared reply keeps corrected presence and copies only this branch's live events", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const t = yield* story("separate")
    const mark = yield* t.event({ key: "away.set", value: { entity: t.wren, away: true, source: "decision" } })
    const source = yield* t.say(t.mira, "An interrupted account of the road.", true)
    const ownMark = yield* t.writer.AddStateEvent({
      userId: t.userId,
      chatId: t.chatId,
      forkId: t.fork(),
      slotId: source.slotId,
      versionId: source.version.id,
      scope: null,
      data: { key: "away.set", value: { entity: t.wren, away: true, source: "decision" } }
    })
    const peer = (yield* t.api.CreateFork({ chatId: t.chatId, fromForkId: t.fork(), atSlotId: source.slotId })).fork.id
    yield* t.writer.AddStateEvent({
      userId: t.userId,
      chatId: t.chatId,
      forkId: peer,
      slotId: source.slotId,
      versionId: source.version.id,
      scope: null,
      data: { key: "away.set", value: { entity: t.mira, away: true } }
    })
    yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: mark.id })
    yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: t.fork(), eventId: ownMark.id })
    const rollout = `source-${source.version.id}`
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,fork_id,kind,status,slot_id,role,request_class,mode,created_at,updated_at) VALUES(?,?,?,'generation','completed',?,'narrator','interactive','default',1,1)",
        params: [rollout, t.chatId, t.fork(), source.slotId]
      },
      {
        sql: "INSERT INTO rollout_payloads(rollout_id,context_snapshot_json) VALUES(?,?)",
        params: [rollout, JSON.stringify({ agent: { contract: "final_text" } })]
      },
      { sql: "UPDATE versions SET rollout_id=? WHERE id=?", params: [rollout, source.version.id] }
    ])
    const entry = (yield* t.reader.GetSlot({ userId: t.userId, slotId: source.slotId, forkId: t.fork() })).entry
    const resumed = yield* t.writer.StartResumedVersion({
      userId: t.userId,
      forkId: t.fork(),
      versionId: source.version.id,
      expectedRowVersion: entry.rowVersion,
      rolloutId: `resumed-${source.version.id}`,
      version: new NewVersion({
        speakerEntityId: t.mira,
        writer: "model",
        content: source.version.content,
        status: "generating",
        macroMode: "verbatim",
        origin: "resumed",
        sourceVersionId: source.version.id
      }),
      transcript: "[]",
      steps: 0,
      keptCalls: [],
      branch: null
    })
    const rows = yield* t.reader.KnowersOf({
      userId: t.userId,
      chatId: t.chatId,
      forkId: resumed.forkId,
      versionIds: [resumed.version.id]
    })
    assert.include(rows[0]!.knowers!, t.wren, "resuming carries this branch's corrected record")
    const state = foldState(
      yield* t.reader.StateEventsAt({
        userId: t.userId,
        chatId: t.chatId,
        forkId: resumed.forkId,
        slotId: source.slotId
      })
    )
    assert.notInclude(state.away, t.mira, "a peer's event attached to the same version cannot enter this branch")
    assert.notInclude(state.away, t.wren, "the suppressed decision cannot reappear under a new event id")
    const peerState = foldState(
      yield* t.reader.StateEventsAt({ userId: t.userId, chatId: t.chatId, forkId: peer, slotId: source.slotId })
    )
    assert.includeMembers([...peerState.away], [t.mira, t.wren])
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

for (const away of [true, false])
  it.live(
    `correction ${away ? "left" : "back"} follows swaps, preserves narrators and nested peers through repeated Undo`,
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* story("separate")
          if (!away) yield* t.event({ key: "away.set", value: { entity: t.wren, away: true } })
          const mark = yield* t.event({ key: "away.set", value: { entity: t.wren, away, source: "decision" } })
          const first = yield* t.say(t.mira, "SWAP-SECRET before replacement")
          const next = yield* t.writer.ForkCard({
            userId: t.userId,
            refId: t.wrenRef,
            name: "Wren next",
            nickname: "Wren",
            characterVersion: "2"
          })
          const replacement = next.entityId as EntityId
          yield* t.event({ key: "card.swap", value: { entity: replacement, replaces: t.wren } })
          const second = yield* t.say(t.mira, "SWAP-SECRET after replacement")
          yield* t.event({ key: "cast.role", value: { entity: replacement, role: "narrator" } })
          const narrated = yield* t.say(t.mira, "NARRATOR-SECRET always known")
          const root = t.fork()
          const forkFrom = (forkId: ForkId) =>
            Effect.map(
              t.writer.CreateFork({
                userId: t.userId,
                chatId: t.chatId,
                fromForkId: forkId,
                atSlotId: narrated.slotId
              }),
              (r) => r.fork.id
            )
          const peer = yield* forkFrom(root)
          const nested = yield* forkFrom(peer)
          const known = (forkId: ForkId) =>
            Effect.map(
              t.reader.KnowersOf({
                userId: t.userId,
                chatId: t.chatId,
                forkId,
                versionIds: [first.version.id, second.version.id, narrated.version.id]
              }),
              (r) => r.map((m, i) => m.knowers!.includes(i === 0 ? t.wren : replacement))
            )
          const before = yield* known(peer)
          for (let i = 0; i < 2; i++) {
            yield* t.writer.CorrectPresence({ userId: t.userId, chatId: t.chatId, forkId: root, eventId: mark.id })
            assert.deepStrictEqual(yield* known(root), [away, away, true], "narrator records never become away")
            const hits = yield* t.reader.SearchChat({
              userId: t.userId,
              chatId: t.chatId,
              forkId: root,
              leafSlotId: narrated.slotId,
              tokens: ["secret"],
              before: null,
              limit: 20,
              viewers: [t.wren, replacement]
            })
            assert.isTrue(
              hits!.some((m) => m.content.includes("NARRATOR-SECRET")),
              "indexed knowledge also preserves narrator records"
            )
            assert.strictEqual(
              hits!.some((m) => m.content.includes("after replacement")),
              away
            )
            assert.deepStrictEqual(yield* known(peer), before)
            assert.deepStrictEqual(yield* known(nested), before)
            const child = yield* forkFrom(root)
            assert.deepStrictEqual(yield* known(child), [away, away, true])
            const history = yield* t.reader.ListHistoryEdits({ userId: t.userId, chatId: t.chatId, forkId: root })
            const edit = history.find((h) => h.title === "Correct scene check" && h.status === "applied")!
            assert.isDefined(edit)
            assert.strictEqual(
              (yield* t.writer.UndoHistoryEdit({
                userId: t.userId,
                chatId: t.chatId,
                forkId: root,
                changesetId: edit.id
              })).undone,
              1
            )
            assert.deepStrictEqual(yield* known(root), before)
            assert.deepStrictEqual(
              yield* known(child),
              [away, away, true],
              "the second correction cannot rewrite the first correction's child"
            )
          }
        })
      )
  )
