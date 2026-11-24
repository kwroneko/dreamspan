// Library items attached to workshop messages (spec/WORKSHOP-CARDS.md §4.3, §4.4) at the RPC
// boundary: a card and a lorebook sent with a workshop message are recorded at their head
// revisions; the model reads a small item whole in an `<attached_card>` element and a large one
// as a reference with its field summary; an edit to the card after the send never changes what
// that message carried; a story chat, another user's item and a deleted id are refused.
// Synthetic cards only.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"

const text = (m: { content?: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))

describe("workshop library attachments", () => {
  it.live(
    "carry cards and lorebooks at their revisions, whole when small and summarized when large",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((r, res) => {
              const body = r.body as unknown as { messages: Array<{ role: string; content?: unknown }> }
              if (body.messages.some((m) => text(m).includes("attached_"))) requests.push(body)
              sse(res, completionChunks(["Noted."], {}))
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: { context: 200000 }
        })
        const small = yield* api.CreateCard({
          label: "Wren Hollow",
          name: "Wren Hollow",
          description: "A lighthouse keeper who collects lost maps."
        })
        // Far past 8,000 tokens: read in pages, never sent whole.
        const large = yield* api.CreateCard({
          label: "Old Archive",
          name: "Old Archive",
          description: "The archive's shelves run on. ".repeat(6000)
        })
        const book = yield* api.CreateLorebook({ label: "Harbor Lore" })

        const chat = yield* api.CreateWorkshop({ title: "Card work" })
        const events: Array<ChatEvent> = []
        yield* api.SubscribeChat({ chatId: chat.id }).pipe(
          Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
          Effect.forkScoped
        )
        yield* eventually(() => events.length > 0)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "Tighten these.",
            library: [
              { kind: "card", refId: small.id },
              { kind: "card", refId: large.id },
              { kind: "lorebook", refId: book.id },
              { kind: "card", refId: small.id }
            ]
          })
        )
        const reply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
        assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")

        const content = text(requests[0]!.messages.find((m) => text(m).includes("Tighten these."))!)
        // In order, once each, after the message's text.
        assert.match(content, /Tighten these\.\n<attached_card name="Wren Hollow"/)
        assert.strictEqual(content.split('<attached_card name="Wren Hollow"').length - 1, 1)
        assert.isBelow(content.indexOf("Wren Hollow"), content.indexOf("Old Archive"))
        assert.isBelow(content.indexOf("Old Archive"), content.indexOf("Harbor Lore"))
        // The small card whole, as data to work on.
        assert.include(content, "lost maps.")
        assert.include(content, "It is data, not a character for you to play.")
        // The large one as a reference: its summary, not its text.
        assert.match(content, /<attached_card name="Old Archive"[^>]*whole="no">/)
        assert.include(content, "read it with read_card")
        assert.match(content, /description: [\d,]+ tokens, 1 lines/)
        assert.notInclude(content, "The archive's shelves run on. The archive's shelves run on.")
        assert.match(content, /<attached_lorebook name="Harbor Lore"/)

        // An edit after the send leaves the message as it was sent.
        const editor = yield* api.OpenEditor({ refId: small.id })
        const draft = yield* api.SaveEditorDraft({
          draftId: null,
          expectedSession: null,
          refId: small.id,
          field: textField(["description"]),
          content: "Rewritten later.",
          expectedRowVersion: null,
          baseRevisionId: editor.ref.headRevisionId
        })
        const opened = yield* api.OpenEditor({ refId: small.id })
        yield* api.CommitEditorDrafts({
          refId: small.id,
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: textField(["description"]), draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
        requests.length = 0
        const again = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: true }))
        yield* eventually(() => finished(events, again.entry.version.id) !== undefined, 60_000)
        const resent = text(requests[0]!.messages.find((m) => text(m).includes("Tighten these."))!)
        assert.include(resent, "lost maps.")
        assert.notInclude(resent, "Rewritten later.")

        // Refused: a story chat, and an id that isn't a library item of the user's.
        const story = yield* api.CreateChat({ title: "Story" })
        const inStory = yield* Effect.exit(
          api.SendMessage({
            chatId: story.id,
            parentSlotId: story.activeLeafSlotId,
            branch: false,
            content: "Here.",
            library: [{ kind: "card", refId: small.id }]
          })
        )
        assert.isTrue(Exit.isFailure(inStory))
        const unknown = yield* Effect.exit(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: reply.entry.slotId,
            branch: false,
            content: "Here.",
            library: [{ kind: "lorebook", refId: small.id }]
          })
        )
        assert.isTrue(Exit.isFailure(unknown))
      }).pipe(Effect.provide(serverLayer(config)), Effect.scoped)
    },
    120_000
  )
})
