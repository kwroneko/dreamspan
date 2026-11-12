// What a side chat's request is made of (spec/WORKSHOP.md §4, ARCHITECTURE §16 "What a side chat
// sends"): its own Workshop preset and Assistant card, never the story's preset, cards, persona,
// lorebooks or messages; the story only as wrapped tool results, read where the request says
// (the branch and newest message of the tab it was sent from), and never past that message.
// All against a mock provider: nothing reaches a real one.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId, StoryAt, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { STORY_NOTICE } from "../src/agent/tools/history.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Body = Record<string, unknown>
type Message = { readonly role: string; readonly content: unknown }
type Api = Effect.Success<ReturnType<typeof client>>

const call = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-s",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-s",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

const toolNames = (body: Body) =>
  ((body.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name)
const messages = (body: Body) => body.messages as Array<Message>
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))
/** This turn's tool results: after the last user message. */
const results = (body: Body) => {
  const all = messages(body)
  const from = all.findLastIndex((m) => m.role === "user")
  return all
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map(textOf)
}

/** Each story request gets a plain reply; a side chat's turn reads the story once, then answers. */
const provider = () =>
  startMockProvider((request, res) => {
    const body = request.body as Body
    if (!toolNames(body).includes("read_story")) return sse(res, completionChunks(["Story reply."], {}))
    sse(
      res,
      results(body).length === 0
        ? call("read_story", { count: 20 }, "call_read")
        : completionChunks(["Out of character: it went well."], {})
    )
  })

/** One side-chat turn sent with `storyAt` (none: as from the workshop's own tab). */
const turn = (api: Api, workshop: Chat, content: string, storyAt: StoryAt | null) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: workshop.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const chat = yield* api.GetChat({ chatId: workshop.id })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content })
    )
    const generated = yield* posted(
      api.Generate({
        chatId: chat.id,
        parentSlotId: sent.entry.slotId,
        branch: false,
        ...(storyAt ? { storyAt } : {})
      })
    )
    yield* eventually(() => finished(events, generated.entry.version.id as VersionId) !== undefined)
    return finished(events, generated.entry.version.id as VersionId)!
  }).pipe(Effect.scoped)

const at = (chat: Chat): StoryAt => ({
  chatId: chat.id,
  forkId: chat.currentForkId!,
  leafSlotId: chat.activeLeafSlotId
})

// Text only the story's own setup holds: none of it may reach the side chat outside a tool result.
const STORY_ONLY = [
  "STORY_MAIN_PROMPT",
  "STORY_POST_HISTORY",
  "STORY_PREFILL",
  "STORY_CONTINUE_NUDGE",
  "STORY_IMPERSONATION",
  "MIRA_CARD_SENTINEL",
  "MIRA_SYSTEM_SENTINEL",
  "MIRA_JAILBREAK_SENTINEL",
  "TOBIN_PERSONA_SENTINEL",
  "STORY_LORE_SENTINEL"
]
// The story's messages: allowed in the side chat only inside a wrapped tool result.
const STORY_MESSAGES = ["MSG_FLOODED_SENTINEL", "Late again"]

describe("side chat request", () => {
  it.live(
    "holds none of the story's preset, cards, persona or lorebooks, and quotes the story only in tool results",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => provider()),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        const writer = yield* Writer
        const userId = (yield* api.Whoami()).id as UserId
        const story = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {},
          content: "MSG_FLOODED_SENTINEL The road flooded.",
          preset: {
            prompts: [
              { identifier: "main", name: "Main", content: "STORY_MAIN_PROMPT Continue the roleplay." },
              { identifier: "chatHistory", name: "Chat History", marker: true },
              { identifier: "jailbreak", name: "Post-History", content: "STORY_POST_HISTORY Stay in character." }
            ],
            prompt_order: [
              {
                character_id: 100001,
                order: [
                  { identifier: "main", enabled: true },
                  { identifier: "chatHistory", enabled: true },
                  { identifier: "jailbreak", enabled: true }
                ]
              }
            ],
            assistant_prefill: "STORY_PREFILL *Mira says*",
            continue_nudge_prompt: "STORY_CONTINUE_NUDGE",
            impersonation_prompt: "STORY_IMPERSONATION",
            names_behavior: 1
          },
          mira: {
            description: "MIRA_CARD_SENTINEL {{char}} keeps the ledger.",
            system_prompt: "MIRA_SYSTEM_SENTINEL",
            post_history_instructions: "MIRA_JAILBREAK_SENTINEL",
            character_book: loreBook([loreEntry({ constant: true, content: "STORY_LORE_SENTINEL from Mira's book" })])
              .document
          },
          lorebook: loreBook([loreEntry({ constant: true, content: "STORY_LORE_SENTINEL from the chat's book" })])
            .document
        })
        // The account persona, which a new workshop is given: a story character's description and book.
        const persona = yield* writer.CreateEntity({
          userId,
          kind: "card",
          label: "Tobin",
          subtitle: "",
          doc: cardDoc("Tobin", {
            description: "TOBIN_PERSONA_SENTINEL {{user}} draws maps.",
            character_book: loreBook([loreEntry({ constant: true, content: "STORY_LORE_SENTINEL from Tobin" })])
              .document
          }) as never,
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        yield* api.SetPersona({ entityId: persona.entityId as EntityId, persona: true })
        yield* api.ChangeGenerationDefaults({ change: { persona: persona.entityId as EntityId } })

        const workshop = yield* api.CreateWorkshop({ attachTo: story.chat.id })
        const before = mock.requests().length
        const version = yield* turn(
          api,
          workshop,
          "How is the story going?",
          at(yield* api.GetChat({ chatId: story.chat.id }))
        )
        assert.strictEqual(version.content, "Out of character: it went well.")
        const bodies = mock
          .requests()
          .slice(before)
          .map((r) => r.body as Body)
        assert.lengthOf(bodies, 2)
        for (const body of bodies) {
          const all = messages(body)
          const outside = all
            .filter((m) => m.role !== "tool")
            .map(textOf)
            .join("\n")
          // The workshop's own preset and card.
          assert.include(outside, "You are the workshop assistant in a roleplay app.")
          assert.include(outside, "You're beside one of")
          for (const sentinel of [...STORY_ONLY, ...STORY_MESSAGES]) assert.notInclude(outside, sentinel, sentinel)
          // Nothing from the story's setup in the tool results either: they hold its messages only.
          for (const sentinel of STORY_ONLY) assert.notInclude(all.map(textOf).join("\n"), sentinel, sentinel)
          // No prefill: the request ends with the user's message or a tool result, never the model's words.
          assert.notStrictEqual(all.at(-1)!.role, "assistant")
        }
        // The story's messages arrive only as one wrapped tool result.
        const [read] = results(bodies[1]!)
        assert.isDefined(read)
        assert.match(read!, /^<story_excerpt story="Ledger" branch="Original" up_to_message="\d+">\n/)
        assert.include(read!, STORY_NOTICE)
        assert.include(read!, "MSG_FLOODED_SENTINEL")
        assert.include(read!, "Late again")
        assert.isTrue(read!.endsWith("</story_excerpt>"))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("reads the branch each request names, never past its message, and nothing without one", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => provider()),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const story = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const original = at(yield* api.GetChat({ chatId: story.chat.id }))
      // A second branch from the greeting, written in last: the story's current branch now.
      yield* posted(
        api.SendMessage({
          chatId: story.chat.id,
          parentSlotId: story.chat.activeLeafSlotId,
          branch: true,
          content: "Down the other road."
        })
      )
      const other = at(yield* api.GetChat({ chatId: story.chat.id }))
      assert.notStrictEqual(other.forkId, original.forkId)
      const workshop = yield* api.CreateWorkshop({ attachTo: story.chat.id })
      const lastRead = () => results(mock.requests().at(-1)!.body as Body)[0]!

      // Two tabs, one on each branch: each request reads its own tab's branch.
      yield* turn(api, workshop, "From the first tab.", original)
      assert.include(lastRead(), "The road flooded.")
      assert.include(lastRead(), "Story reply.")
      assert.notInclude(lastRead(), "Down the other road.")
      yield* turn(api, workshop, "From the second tab.", other)
      assert.include(lastRead(), "Down the other road.")
      assert.notInclude(lastRead(), "The road flooded.")
      // The tab that is behind (an older message shown) sends where it is: nothing later is read.
      yield* posted(
        api.SendMessage({
          chatId: story.chat.id,
          parentSlotId: other.leafSlotId,
          branch: false,
          content: "A third road, later."
        })
      )
      yield* turn(api, workshop, "Still from the second tab.", other)
      assert.notInclude(lastRead(), "A third road, later.")
      assert.match(lastRead(), /up_to_message="2"/)

      // Sent without a position (the workshop in its own tab): the story isn't read.
      yield* turn(api, workshop, "From its own tab.", null)
      assert.include(lastRead(), "wasn't sent from beside the story")
      assert.notInclude(lastRead(), "Late again")
      // A position in another chat is refused.
      const elsewhere = yield* api.CreateChat({ title: "Elsewhere" })
      yield* turn(api, workshop, "Somewhere else.", { ...other, chatId: elsewhere.id })
      assert.include(lastRead(), "another chat")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
