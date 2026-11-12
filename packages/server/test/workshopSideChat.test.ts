// The side chat (spec/WORKSHOP.md §4, W9): a workshop attached to a story reads it through its story
// tools at the story's position (its current branch, up to that branch's newest message), never
// another branch, chat or user, and nothing of it reaches the story's requests or rows.
import { assert, describe, it } from "@effect/vitest"
import type { Chat, EntityId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { ApprovalPrompt } from "@rp/shared/agent.ts"
import { writeFileSync } from "node:fs"
import { Effect, Stream } from "effect"
import { Writer } from "../src/db/Database.ts"
import { client, login, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Body = Record<string, unknown>
type Message = { readonly role: string; readonly content: unknown }

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
/** This turn's tool results: after the last user message (a carried request holds earlier turns'). */
const results = (body: Body) => {
  const messages = body.messages as Array<Message>
  const from = messages.findLastIndex((m) => m.role === "user")
  return messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content))
}
const text = (body: Body) =>
  (body.messages as Array<Message>).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))

/**
 * One provider for both chats: a story request gets a plain reply; a side chat's turn reads the
 * story (read_story, then search_story for "flooded"), then answers.
 */
const provider = () =>
  startMockProvider((request, res) => {
    const body = request.body as Body
    if (!toolNames(body).includes("read_story")) return sse(res, completionChunks(["Story reply."], {}))
    const done = results(body).length
    sse(
      res,
      done === 0
        ? call("read_story", {}, "call_read")
        : done === 1
          ? call("search_story", { query: "flooded" }, "call_search")
          : completionChunks(["You took the other road."], {})
    )
  })

type Api = Effect.Success<ReturnType<typeof client>>

/**
 * One workshop turn: the user's message, then the reply, waited for to its end. With `prompts`,
 * each call waiting for the user is allowed once and its approval kept there.
 */
const turn = (api: Api, workshop: Chat, content: string, prompts?: Array<ApprovalPrompt>) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    const answered = new Set<string>()
    yield* api.SubscribeChat({ chatId: workshop.id }).pipe(
      Stream.runForEach((batch) =>
        Effect.gen(function* () {
          events.push(...batch)
          for (const event of batch)
            if (event._tag === "Steps" && prompts)
              for (const step of event.steps)
                if (step.kind === "tool" && step.approval && !answered.has(step.approval.toolCallId)) {
                  answered.add(step.approval.toolCallId)
                  prompts.push(step.approval)
                  yield* api.AnswerToolApproval({
                    rolloutId: step.approval.rolloutId,
                    toolCallId: step.approval.toolCallId,
                    digest: step.approval.digest,
                    answer: "allow"
                  })
                }
        })
      ),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    const chat = yield* api.GetChat({ chatId: workshop.id })
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, generated.entry.version.id as VersionId) !== undefined)
    return finished(events, generated.entry.version.id as VersionId)!
  }).pipe(Effect.scoped)

describe("side chat", () => {
  it.live("reads only the story's current branch at its position, and only the owner's", () => {
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
      const greeting = story.chat.activeLeafSlotId!
      // Another branch from the greeting, written in last: the story's current branch now.
      const branched = yield* posted(
        api.SendMessage({
          chatId: story.chat.id,
          parentSlotId: greeting,
          branch: true,
          content: "Down the other road."
        })
      )
      const workshop = yield* api.CreateWorkshop({ attachTo: story.chat.id })
      assert.strictEqual(workshop.kind, "workshop")
      assert.strictEqual(workshop.title, "About Ledger")
      assert.deepStrictEqual(
        (yield* api.ListAttachedWorkshops({ chatId: story.chat.id })).map((c) => c.id),
        [workshop.id]
      )
      // §4: reading its story is allowed in this workshop, a choice the strip shows and can change.
      const read = (yield* api.ListWorkshopCapabilities({ chatId: workshop.id })).find((c) => c.id === "chats.read")
      assert.strictEqual(read?.mode, "allow")
      assert.isTrue(read?.chosen)

      const before = mock.requests().length
      const version = yield* turn(api, workshop, "What happened so far?")
      assert.strictEqual(version.content, "You took the other road.")
      const bodies = mock
        .requests()
        .slice(before)
        .map((r) => r.body as Body)
      assert.lengthOf(bodies, 3)
      assert.includeMembers(toolNames(bodies[0]!), [
        "search_story",
        "read_story",
        "open_story_summary",
        "search_story_summaries"
      ])
      assert.include(text(bodies[0]!).join("\n"), "You're beside one of")
      // No story message is in the side chat's own history: only in tool results.
      assert.notInclude(text(bodies[0]!).join("\n"), "Late again")
      const [readResult, searchResult] = results(bodies[2]!)
      assert.include(readResult, "Late again")
      assert.include(readResult, "Down the other road.")
      // The first branch's messages are another branch's: never read.
      assert.notInclude(readResult, "The road flooded.")
      assert.notInclude(readResult, "Story reply.")
      assert.notInclude(searchResult, "The road flooded.")
      assert.include(searchResult, "No earlier messages match")

      // The story moves on: the next request reads where it is then.
      yield* posted(
        api.SendMessage({
          chatId: story.chat.id,
          parentSlotId: branched.entry.slotId,
          branch: false,
          content: "A third road, later."
        })
      )
      const again = mock.requests().length
      yield* turn(api, workshop, "And now?")
      assert.include(results(mock.requests()[again + 2]!.body as Body)[0], "A third road, later.")

      // Off takes the story tools out of the next turn (W4's permissions, unchanged here).
      yield* api.SetWorkshopGrant({ chatId: workshop.id, capability: "chats.read", mode: "off" })
      const off = mock.requests().length
      yield* turn(api, workshop, "Without reading?")
      const offBody = mock.requests()[off]!.body as Body
      assert.notInclude(toolNames(offBody), "read_story")
      assert.include(text(offBody).join("\n"), "Turned off in this workshop: Read your chats")
      // Back to the default, Ask first: each read waits in its step for the user, naming the story.
      yield* api.SetWorkshopGrant({ chatId: workshop.id, capability: "chats.read", mode: null })
      const prompts: Array<ApprovalPrompt> = []
      yield* turn(api, workshop, "Ask before reading.", prompts)
      assert.deepStrictEqual(
        prompts.map((p) => [p.capability, p.title]),
        [
          ["chats.read", "Read the story “Ledger”"],
          ["chats.read", "Search the story “Ledger”"]
        ]
      )
      yield* api.SetWorkshopGrant({ chatId: workshop.id, capability: "chats.read", mode: "allow" })

      // Refused targets: a workshop, a chat that doesn't exist.
      assert.strictEqual(yield* outcome(api.CreateWorkshop({ attachTo: workshop.id })), "NotFound")
      assert.strictEqual(
        yield* outcome(api.CreateWorkshop({ attachTo: "00000000-0000-7000-8000-000000000000" as Chat["id"] })),
        "NotFound"
      )
      // Nothing written in the story: its own state has no attachment.
      const [storyEvents] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT count(*) AS n FROM state_events WHERE chat_id = ? AND key = 'workshop.attached'",
            params: [story.chat.id]
          }
        ],
        { readOnly: true }
      )
      assert.strictEqual(storyEvents![0]!.n, 0)

      // Another user: no attachment to someone else's story, even written directly as state.
      const admin = yield* api.Whoami()
      yield* api.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "alice-password" })
      const alice = yield* client({ cookie: (yield* login(admin.handle, "alice-password")).cookie })
      yield* alice.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
      const bob = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
      const theirs = yield* bob.CreateWorkshop({})
      const otherUser = yield* bob.Whoami()
      const writer = yield* Writer
      assert.strictEqual(
        yield* outcome(
          writer.AddStateEvent({
            userId: otherUser.id,
            chatId: theirs.id,
            slotId: null,
            versionId: null,
            scope: null,
            data: { key: "workshop.attached", value: { chat: story.chat.id } }
          })
        ),
        "NotFound"
      )
      assert.strictEqual(yield* outcome(bob.ListAttachedWorkshops({ chatId: story.chat.id })), "NotFound")
      assert.strictEqual(yield* outcome(bob.CreateWorkshop({ attachTo: story.chat.id })), "NotFound")

      // The story in the bin: the side chat says so, and the story lists nothing.
      yield* alice.DeleteChat({ chatId: story.chat.id })
      const gone = mock.requests().length
      yield* turn(alice, workshop, "Is it still there?")
      assert.include(results(mock.requests()[gone + 1]!.body as Body)[0], "isn't available any more")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  /** A story's next request and rows, generated with or without a side chat that read it first. */
  const storyRun = (sideChat: boolean) => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() => provider()),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      let workshopRequests = 0
      const result = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        ...(sideChat
          ? {
              before: (chat: Chat, _characters: ReadonlyArray<EntityId>) =>
                Effect.gen(function* () {
                  const workshop = yield* api.CreateWorkshop({ attachTo: chat.id })
                  const done = yield* turn(api, workshop, "What happened so far?")
                  assert.strictEqual(done.content, "You took the other road.")
                  workshopRequests = mock.requests().length
                })
            }
          : {})
      })
      assert.strictEqual(workshopRequests, sideChat ? 3 : 0)
      const story = mock
        .requests()
        .slice(workshopRequests)
        .map((r) => r.body as Body)
      assert.lengthOf(story, 1)
      const id = result.chat.id
      const rows = yield* fixtureSql(
        config.dataDir,
        [
          { sql: "SELECT * FROM chats WHERE id = ?", params: [id] },
          { sql: "SELECT * FROM slots WHERE chat_id = ? ORDER BY depth", params: [id] },
          {
            sql: "SELECT v.* FROM versions v JOIN slots s ON s.id = v.slot_id WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal",
            params: [id]
          },
          {
            sql: "SELECT t.* FROM version_texts t JOIN versions v ON v.seq = t.version_seq JOIN slots s ON s.id = v.slot_id WHERE s.chat_id = ? ORDER BY s.depth, v.ordinal",
            params: [id]
          },
          { sql: "SELECT * FROM rollouts WHERE chat_id = ? ORDER BY created_at, id", params: [id] },
          {
            sql: "SELECT p.* FROM rollout_payloads p JOIN rollouts r ON r.id = p.rollout_id WHERE r.chat_id = ? ORDER BY r.created_at, r.id",
            params: [id]
          },
          { sql: "SELECT * FROM state_events WHERE chat_id = ? ORDER BY seq", params: [id] },
          { sql: "SELECT * FROM forks WHERE chat_id = ? ORDER BY created_at, id", params: [id] }
        ],
        { readOnly: true }
      )
      return normalize({ request: story[0], rows })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  }

  it.live("leaves the story's requests and rows byte for byte as without it", () =>
    Effect.gen(function* () {
      const plain = yield* storyRun(false)
      const beside = yield* storyRun(true)
      if (process.env.SIDE_CHAT_PARITY_OUTPUT)
        writeFileSync(
          process.env.SIDE_CHAT_PARITY_OUTPUT,
          `${JSON.stringify(plain, null, 1)}\n---\n${JSON.stringify(beside, null, 1)}`
        )
      assert.strictEqual(JSON.stringify(beside), JSON.stringify(plain))
      // The side chat's words never reach the story's request.
      assert.notInclude(JSON.stringify(beside), "What happened so far?")
      assert.notInclude(JSON.stringify(beside), "You took the other road.")
    })
  )
})

/** Generated identities (and identity hashes), clocks and durations differ between runs; nothing else may. */
const normalize = (input: unknown) => {
  const ids = new Map<string, string>()
  const derived = new Map<string, string>()
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
  const named = (id: string) => {
    if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`)
    return ids.get(id)!
  }
  const walk = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (/^[0-9a-f]{64}$/.test(value)) {
        if (!derived.has(value)) derived.set(value, `derived-${derived.size + 1}`)
        return derived.get(value)!
      }
      if (/^[{[]/.test(value)) {
        try {
          return walk(JSON.parse(value), key)
        } catch {
          /* ordinary text */
        }
      }
      return value.replace(uuid, named)
    }
    // Versions' sequence numbers count every chat's versions, the side chat's too: an identity.
    // (A state event's `seq` is its own chat's order, compared as it is.)
    if (typeof value === "number" && (key === "seq" || key === "version_seq")) return named(`seq:${value}`)
    if (typeof value === "number" && key === "event_seq") return value
    if (
      typeof value === "number" &&
      (/(?:_at|At)$/.test(key) || ["now", "timestamp", "ms", "durationMs"].includes(key))
    )
      return 0
    if (Array.isArray(value)) return value.map((part) => walk(part))
    if (value && typeof value === "object") {
      const event = "value_json" in value
      return Object.fromEntries(
        Object.entries(value).map(([name, part]) => [
          name.replace(uuid, named),
          walk(part, event && name === "seq" ? "event_seq" : name)
        ])
      )
    }
    return value
  }
  return walk(input)
}
