// An ST chat where the user played two personas (DESIGN §2.2): every persona who spoke is the
// user's, never a character. Only the last one is selected; the others joined for their own
// messages and left, as a persona switched away from in the chat does. None gets a model turn,
// counts for Next, rounds, the title or a new chat's members, or is assembled as a character;
// the user can still switch to any of them. Owner-shaped synthetic data: a switch every 300
// messages, one-to-one and group chats, branches of branches (scale: importedPersonasScale).
import { assert, describe, it } from "@effect/vitest"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Writer } from "../src/db/Database.ts"
import type { ChatId, EntityId, ForkId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { INN, KAREN, KIM, personaSwitchFolder, RHEE } from "./support/stPersonaSwitches.ts"
import { importStFolder } from "./support/stUpload.ts"
import { checkImportedPersonas } from "./support/importedPersonas.ts"

type Wire = { role: string; content?: unknown }
const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content ?? ""))

describe("personas of an imported ST chat", () => {
  it.live(
    "are the user's: cast, Next, the request, new group chats and switching",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const folder = personaSwitchFolder({ messages: 900, switchEvery: 300, singleBranches: 20, groupBranches: 30 })
        const { answers } = yield* importStFolder(folder.files)
        assert.isFalse([...answers.values()].some((r) => r.outcome === "failed"))
        const api = yield* client()
        const { names, records } = yield* checkImportedPersonas(api, folder)

        // The request a reply is generated from, through the real assembler and a provider.
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() => startMockProvider((_, res) => sse(res, completionChunks(["A reply."], {})))),
          (m) => Effect.promise(() => m.close())
        )
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Mock",
            baseUrl: `${mock.url}/v1`,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({
          connectionId: connection.id,
          key: "mock-model",
          overrides: { context: 1_000_000, maxOutput: 1000 }
        })
        yield* api.ChangeGenerationDefaults({ change: { model: { connection: connection.id, model: model.id } } })

        const generate = (chatId: ChatId, forkId: ForkId, speaker?: EntityId) =>
          Effect.gen(function* () {
            const events: Array<ChatEvent> = []
            yield* api.SubscribeChat({ chatId }).pipe(
              Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
              Effect.forkScoped
            )
            yield* eventually(() => events.length > 0)
            const path = yield* api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 5 })
            const before = mock.requests().length
            const reply = yield* posted(
              api.Generate({
                chatId,
                forkId,
                parentSlotId: path.entries.at(-1)!.slotId as SlotId,
                branch: false,
                ...(speaker ? { speakerEntityId: speaker } : {})
              })
            )
            yield* eventually(() => finished(events, reply.entry.version.id) !== undefined, 60_000)
            assert.strictEqual(finished(events, reply.entry.version.id)!.status, "complete")
            const sent = mock.requests().slice(before)
            assert.lengthOf(sent, 1, "one reply, no round after it")
            return {
              reply: reply.entry,
              messages: (sent[0]!.body!.messages as Array<Wire>).map((m) => ({ role: m.role, text: text(m.content) }))
            }
          })

        const swipe = (chatId: ChatId, forkId: ForkId, entry: PathEntry) =>
          Effect.gen(function* () {
            const events: Array<ChatEvent> = []
            yield* api.SubscribeChat({ chatId }).pipe(
              Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
              Effect.forkScoped
            )
            yield* eventually(() => events.length > 0)
            const before = mock.requests().length
            const swiped = yield* api.Regenerate({ slotId: entry.slotId, forkId, expectedRowVersion: entry.rowVersion })
            yield* eventually(() => finished(events, swiped.version.id) !== undefined, 60_000)
            assert.strictEqual(finished(events, swiped.version.id)!.status, "complete")
            const sent = mock.requests().slice(before)
            assert.lengthOf(sent, 1, "one swipe, no round after it")
            return {
              reply: swiped,
              messages: (sent[0]!.body!.messages as Array<Wire>).map((m) => ({ role: m.role, text: text(m.content) }))
            }
          })

        for (const main of [
          `chats/${KAREN}/${KAREN} - 2025-11-01@20h00m00s.jsonl`,
          "group chats/2025-11-02@21h00m00s.jsonl"
        ]) {
          const record = records.get(main)!
          const selected = folder.lastPersona.get(main)!
          const other = selected === KIM.name ? RHEE : KIM
          const persona = selected === KIM.name ? KIM : RHEE
          const leaf = (yield* api.ReadPath({
            chatId: record.chatId,
            forkId: record.forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          })).entries.at(-1)!.slotId
          const next = yield* api.GetNextContext({ chatId: record.chatId, forkId: record.forkId, leafSlotId: leaf })
          const blocks = next.presetContext!.blocks
          assert.sameMembers(
            [...blocks.find((b) => b.identifier === "charDescription")!.labels],
            main.startsWith("chats/") ? [KAREN] : INN.members
          )
          assert.deepStrictEqual(
            [...(blocks.find((b) => b.identifier === "personaDescription")?.labels ?? [])],
            [persona.name]
          )
          const { reply, messages } = yield* generate(record.chatId, record.forkId)
          // The model writes a character, never the other persona.
          assert.notInclude([persona.name, other.name], names.get(reply.version.speakerEntityId!))
          const all = messages.map((m) => m.text).join("\n")
          assert.include(all, persona.description)
          assert.notInclude(all, other.description, "the other persona's description isn't sent as a character's")
          assert.notInclude(all, `Write ${other.name}'s next message`)
          // The other persona's messages stay in the history, on the user's side.
          const theirs = messages.filter((m) => m.text.includes(`${other.name} (main,`))
          assert.isAbove(theirs.length, 0)
          for (const m of theirs) assert.strictEqual(m.role, "user")
          // A swipe of the reply is sent the same way (review-personacast1).
          const swiped = yield* swipe(record.chatId, record.forkId, reply)
          assert.notInclude([persona.name, other.name], names.get(swiped.reply.version.speakerEntityId!))
          assert.notInclude(swiped.messages.map((m) => m.text).join("\n"), other.description)
          // And with separate contexts, where each character reads what it knew.
          if (main.startsWith("group chats/")) {
            const user = yield* api.Whoami()
            const tipNow = (yield* api.ReadPath({
              chatId: record.chatId,
              forkId: record.forkId,
              leafSlotId: null,
              range: { _tag: "Bottom" },
              limit: 1
            })).entries.at(-1)!.slotId
            yield* (yield* Writer).AddStateEvent({
              userId: user.id,
              chatId: record.chatId,
              forkId: record.forkId,
              slotId: tipNow as SlotId,
              versionId: null,
              scope: null,
              data: { key: "context.per_speaker", value: "separate" }
            })
            const separate = yield* generate(record.chatId, record.forkId)
            assert.notInclude([persona.name, other.name], names.get(separate.reply.version.speakerEntityId!))
            const sent = separate.messages.map((m) => m.text).join("\n")
            assert.include(sent, persona.description)
            assert.notInclude(sent, other.description)
            assert.notInclude(sent, `Write ${other.name}'s next message`)
          }
        }

        // Switching persona to any of them still works, from the persona control.
        const main = records.get(`chats/${KAREN}/${KAREN} - 2025-11-01@20h00m00s.jsonl`)!
        const otherName =
          folder.lastPersona.get(`chats/${KAREN}/${KAREN} - 2025-11-01@20h00m00s.jsonl`) === KIM.name
            ? RHEE.name
            : KIM.name
        const otherId = [...names].find(([, n]) => n === otherName)![0] as EntityId
        const tip = (yield* api.ReadPath({
          chatId: main.chatId,
          forkId: main.forkId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 1
        })).entries.at(-1)!.slotId
        const before = yield* api.GetCast({ chatId: main.chatId, slotId: tip, forkId: main.forkId })
        yield* api.ChangeCast({
          chatId: main.chatId,
          forkId: main.forkId,
          slotId: tip,
          change: { _tag: "Persona", entityId: otherId }
        })
        const after = yield* api.GetCast({ chatId: main.chatId, slotId: tip, forkId: main.forkId })
        assert.deepStrictEqual(after.playedByMe, [otherId])
        assert.deepStrictEqual(
          after.participants.filter((id) => !after.playedByMe.includes(id)).map((id) => names.get(id)),
          [KAREN]
        )
        assert.notInclude(after.participants, before.playedByMe[0])
        // Generating as a persona explicitly is the one way the model writes for it.
        const as = yield* generate(main.chatId, main.forkId, otherId)
        assert.strictEqual(as.reply.version.speakerEntityId, otherId)
        assert.include(as.messages.at(-1)!.text, `Write ${otherName}'s next message`)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    },
    600_000
  )
})
