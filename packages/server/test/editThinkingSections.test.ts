// A message's thinking that is tagged thinking in its reply (review-thinkedit1): SillyTavern's
// reasoning on an imported chat's messages (`extra.reasoning`, its `parsed` type a reply
// section here) and what the reasoning auto-parse took out of a reply are the message's own
// thinking in its edit, as ST's reasoning block is: kept by a text edit, changed or removed
// in place of the sections, in a user's own version's history, and exported back with ST's
// `reasoning_type` (`edited`, `manual`) where the user had a hand in it. Synthetic data only.
import { assert, layer } from "@effect/vitest"
import { type ChatId, type EntityId, NewVersion, type PathEntry, type Version } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { ReportBuilder } from "@dreamspan/shared/importReport.ts"
import { editableThinking } from "@dreamspan/shared/replySections.ts"
import { Effect } from "effect"
import { Writer } from "../src/db/Database.ts"
import { parseStChatPart, type StMessage } from "../src/formats/stChat.ts"
import { stLine } from "../src/formats/stChatExport.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { card, encode, header, jsonl } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const at = (minute: number) => new Date(Date.UTC(2025, 0, 1, 10, minute)).toISOString()

/** One chat whose replies have each of ST's reasoning types. */
const chatLines = [
  header({}),
  {
    name: "Ivy",
    is_user: false,
    send_date: at(0),
    mes: "The kettle sings.",
    extra: { reasoning: "Open with the kettle.", reasoning_type: "parsed" }
  },
  { name: "Sam", is_user: true, send_date: at(1), mes: "Tea, then.", extra: {} },
  {
    name: "Ivy",
    is_user: false,
    send_date: at(2),
    mes: "Mint or black?",
    swipe_id: 1,
    swipes: ["Which tea?", "Mint or black?", "Sugar?"],
    swipe_info: [
      { send_date: at(2), extra: { reasoning: "Ask about tea.", reasoning_type: "model" } },
      { send_date: at(2), extra: { reasoning: "Offer two teas.", reasoning_type: "edited" } },
      { send_date: at(2), extra: { reasoning: "Ask about sugar.", reasoning_type: "manual" } }
    ],
    extra: { reasoning: "Offer two teas.", reasoning_type: "edited" }
  }
]

const folder = (): ReadonlyMap<string, Uint8Array> =>
  new Map([
    ["settings.json", encode({ username: "Sam", power_user: {} })],
    ["characters/Ivy.png", card("Ivy", "The kettle sings.")],
    ["chats/Ivy/Ivy - tea.jsonl", jsonl(chatLines)]
  ])

const pathOf = (api: Api, chatId: ChatId) =>
  api
    .ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
    .pipe(Effect.map((path) => path.entries))

/** A message as an ST line, with the versions its fork shows. */
const lineOf = (api: Api, entry: PathEntry, name: string, user = false) =>
  Effect.map(
    api.ListVersions({ slotId: entry.slotId }),
    (versions) =>
      JSON.parse(stLine(entry, versions, { name, user }, "Sam")) as {
        mes: string
        extra: { reasoning?: string; reasoning_type?: string }
        swipes?: Array<string>
        swipe_info?: Array<{ extra: { reasoning?: string; reasoning_type?: string } }>
      }
  )

const sectionText = (version: Version) => version.replySections?.sections.map((s) => s.text)

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "tagged thinking in a message's edit",
  (it) => {
    it.effect("imported ST reasoning is the message's thinking, edited, removed and exported back", () =>
      Effect.gen(function* () {
        const { api } = yield* importStFolder(folder())
        const chat = (yield* api.ListChats({ limit: 10, before: null })).find((c) => c.title === "Ivy - tea")!
        assert.isDefined(chat)
        const [first, , third] = yield* pathOf(api, chat.id)
        // ST's parsed reasoning is the reply's tagged thinking, which the edit shows as its thinking.
        assert.isUndefined(first!.version.reasoning)
        assert.deepStrictEqual(sectionText(first!.version), ["Open with the kettle."])
        assert.strictEqual(editableThinking(first!.version), "Open with the kettle.")

        // The thinking field's draft starts from it.
        const target = { _tag: "EditThinking", versionId: first!.version.id } as const
        const typed = yield* api.SaveMessageDraft({
          target,
          draftId: null,
          content: "Open with the kettle, softly.",
          expectedRowVersion: null,
          expectedSession: null
        })
        const states = yield* api.MessageDraftHistory({ target, limit: 10 })
        assert.strictEqual(states.at(-1)!.length, "Open with the kettle.".length)

        // A text edit keeps it, in its tags.
        const kept = yield* api.EditVersion({
          slotId: first!.slotId,
          sourceVersionId: first!.version.id,
          content: "The kettle sings loudly.",
          reasoning: "Open with the kettle.",
          expectedRowVersion: first!.rowVersion
        })
        assert.deepStrictEqual(kept.version.replySections, first!.version.replySections)
        assert.isUndefined(kept.version.reasoning)

        // Changed: still the reply's tagged thinking, in the tags it came in; its draft committed.
        const changed = yield* api.EditVersion({
          slotId: first!.slotId,
          sourceVersionId: first!.version.id,
          content: first!.version.content,
          reasoning: "Open with the kettle, softly.",
          expectedRowVersion: kept.rowVersion,
          reasoningDraft: { draftId: typed.id, session: typed.session }
        })
        assert.deepStrictEqual(sectionText(changed.version), ["Open with the kettle, softly."])
        assert.strictEqual(changed.version.replySections!.sections[0]!.open, "<think>")
        assert.isUndefined(changed.version.reasoning)
        assert.isFalse((yield* api.MessageDrafts({ chatId: chat.id })).some((d) => d.id === typed.id))

        // Exported: the edited thinking as ST's edited reasoning; the reply as it came stays parsed.
        const edited = yield* lineOf(api, changed, "Ivy")
        assert.deepStrictEqual(edited.extra.reasoning, "Open with the kettle, softly.")
        assert.strictEqual(edited.extra.reasoning_type, "edited")
        assert.deepStrictEqual(
          edited.swipe_info!.map((s) => [s.extra.reasoning, s.extra.reasoning_type]),
          [
            ["Open with the kettle.", "parsed"],
            // The text edit kept the reply's: still ST's parsed reasoning.
            ["Open with the kettle.", "parsed"],
            ["Open with the kettle, softly.", "edited"]
          ]
        )

        // The user's own version: in place, the earlier sections in its history, and restored.
        const amended = yield* api.AmendVersion({
          versionId: changed.version.id,
          content: changed.version.content,
          reasoning: "Start with steam.",
          expectedRowVersion: changed.version.rowVersion
        })
        assert.strictEqual(amended.id, changed.version.id)
        assert.deepStrictEqual(sectionText(amended), ["Start with steam."])
        const removed = yield* api.AmendVersion({
          versionId: changed.version.id,
          content: changed.version.content,
          reasoning: "",
          expectedRowVersion: amended.rowVersion
        })
        assert.isUndefined(removed.replySections)
        assert.isUndefined(removed.reasoning)
        const history = yield* api.VersionAmendments({ versionId: changed.version.id })
        assert.deepStrictEqual(
          history.map((s) => s.sections?.sections.map((section) => section.text) ?? null),
          [["Start with steam."], ["Open with the kettle, softly."]]
        )
        const restored = yield* api.RestoreVersionAmendment({
          versionId: changed.version.id,
          amendmentId: history.at(-1)!.id,
          forkId: chat.currentForkId!,
          expectedRowVersion: removed.rowVersion
        })
        assert.deepStrictEqual(sectionText(restored), ["Open with the kettle, softly."])

        // ST's own types come back as they were imported.
        const line = yield* lineOf(api, third!, "Ivy")
        assert.deepStrictEqual(
          line.swipe_info!.map((s) => [s.extra.reasoning, s.extra.reasoning_type]),
          [
            ["Ask about tea.", "model"],
            ["Offer two teas.", "edited"],
            ["Ask about sugar.", "manual"]
          ]
        )
        assert.strictEqual(line.extra.reasoning_type, "edited")
        // Thinking added where there was none is ST's manual reasoning.
        const user = (yield* pathOf(api, chat.id))[1]!
        const added = yield* api.AmendVersion({
          versionId: user.version.id,
          content: user.version.content,
          reasoning: "Sam is thirsty.",
          expectedRowVersion: user.version.rowVersion
        })
        assert.strictEqual(added.reasoning, "Sam is thirsty.")
        const userLine = yield* lineOf(api, { ...user, version: added }, "Sam", true)
        assert.deepStrictEqual(userLine.extra, { reasoning: "Sam is thirsty.", reasoning_type: "manual" })
      })
    )

    it.effect("with the provider's reasoning too, the edit changes that, and the sections stay", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const writer = yield* Writer
        const userId = (yield* api.Whoami()).id as UserId
        const { entityId } = yield* writer.CreateEntity({
          userId,
          kind: "card",
          label: "Rook",
          subtitle: "",
          doc: cardDoc("Rook"),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const sections = {
          sections: [{ lead: "", open: "<plan>", text: "Count the coins.", close: "</plan>" }],
          gap: "\n"
        }
        const chat = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Synthetic both",
          participants: [entityId as EntityId],
          greeting: new NewVersion({
            speakerEntityId: entityId as EntityId,
            writer: "model",
            content: "Twelve coins.",
            reasoning: "Provider thoughts.",
            replySections: sections,
            status: "complete",
            macroMode: "verbatim",
            origin: "greeting"
          })
        })
        const [entry] = yield* pathOf(api, chat.id)
        assert.strictEqual(editableThinking(entry!.version), "Provider thoughts.")
        const changed = yield* api.EditVersion({
          slotId: entry!.slotId,
          sourceVersionId: entry!.version.id,
          content: entry!.version.content,
          reasoning: "",
          expectedRowVersion: entry!.rowVersion
        })
        assert.isUndefined(changed.version.reasoning)
        assert.deepStrictEqual(changed.version.replySections, sections)
      })
    )

    it.effect("an exported line imports again as the same thinking", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const chat = (yield* api.ListChats({ limit: 10, before: null })).find((c) => c.title === "Ivy - tea")!
        const entries = yield* pathOf(api, chat.id)
        const lines: Array<unknown> = [header({})]
        // The second message is Sam's.
        for (const [i, entry] of entries.entries())
          lines.push(yield* lineOf(api, entry, i === 1 ? "Sam" : "Ivy", i === 1))
        const parsed = parseStChatPart(jsonl(lines), { first: true, firstIndex: 0, carryAt: null }, new ReportBuilder())
        const messages = parsed.batches.flatMap((b) => JSON.parse(b.messagesJson) as Array<StMessage>)
        const thinking = (m: StMessage) =>
          m.versions.map((v) => [
            v.reasoning,
            v.sections?.sections.map((s) => s.text) ?? null,
            v.generation?.reasoningType ?? null
          ])
        assert.deepStrictEqual(thinking(messages[2]!), [
          ["Ask about tea.", null, null],
          ["Offer two teas.", null, "edited"],
          ["Ask about sugar.", null, "manual"]
        ])
        // The first message's versions: the reply as it came (parsed), the text edit (parsed),
        // and the edited one (ST's edited reasoning, which is the reasoning block on the way in).
        assert.deepStrictEqual(thinking(messages[0]!), [
          [null, ["Open with the kettle."], null],
          [null, ["Open with the kettle."], null],
          ["Open with the kettle, softly.", null, "edited"]
        ])
      })
    )
  }
)
