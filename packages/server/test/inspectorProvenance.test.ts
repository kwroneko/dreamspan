import { importStPreset } from "../src/formats/preset.ts"
// The inspector's "debug symbols" (ARCHITECTURE §15): every part of a sent request says what it
// is and where it came from, recorded at send time, and a capture from before parts were
// recorded still opens with its text. Synthetic cards, notes and lore through a mock provider.
import { assert, it } from "@effect/vitest"
import type { EntityId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ContextMessage, RunContext } from "@rp/shared/inspectorApi.ts"
import type { StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

/** The text of each part whose source matches, as the inspector marks it in its message. */
const partTexts = (run: RunContext, match: (label: string) => boolean) =>
  run.messages.flatMap((m: ContextMessage) =>
    (m.parts ?? []).flatMap((p) => (match(m.sources[p.source]!.label) ? [m.content.slice(p.start, p.end)] : []))
  )

const sourceOf = (run: RunContext, match: (label: string) => boolean) =>
  run.messages.flatMap((m) => m.sources).find((s) => match(s.label))

it.live(
  "every part of a request records what it is and where it came from, sent or not",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_req, res) =>
            sse(res, completionChunks(["The lamp gutters."], { prompt_tokens: 10, completion_tokens: 3 }))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const writer = yield* Writer
      const me = yield* api.Whoami()
      const {
        chat,
        events,
        version: first
      } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        personality: "Dry and careful.",
        preset: {
          personality_format: "[Mira's manner:\n{{personality}}]",
          prompts: [
            {
              identifier: "fresh",
              name: "Fresh only",
              content: "Begin.",
              system_prompt: false,
              injection_trigger: ["normal"]
            },
            {
              identifier: "no-impersonation",
              name: "No impersonation",
              content: "Never write for {{user}}.",
              system_prompt: false,
              condition: "as_character"
            }
          ],
          prompt_order: [
            {
              character_id: 100001,
              order: [
                { identifier: "fresh", enabled: true },
                { identifier: "no-impersonation", enabled: true },
                ...importStPreset('{"frequency_penalty":0}').document!.order.map((e) => ({
                  identifier: e.identifier,
                  enabled: e.enabled
                }))
              ]
            }
          ]
        }
      })
      const cards = yield* api.ListCards()
      const tobin = cards.find((c) => c.label === "Tobin")!.entityId as EntityId
      const create = (kind: "lorebook" | "note", label: string, doc: Record<string, unknown>) =>
        writer.CreateEntity({
          userId: me.id,
          kind,
          label,
          subtitle: "",
          doc: doc as never,
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
      const note = (title: string, content: string, extra: Record<string, unknown> = {}) =>
        create("note", title, {
          schema_version: 1,
          title,
          content,
          placement: { mode: "depth", depth: 0, role: "system" },
          owner: { chat: chat.id },
          exportable: false,
          ...extra
        })
      const book = yield* create(
        "lorebook",
        "Harbor",
        loreBook(
          [
            loreEntry(
              { keys: ["lighthouse"], comment: "The lighthouse", content: "The lighthouse burns whale oil." },
              3
            )
          ],
          { name: "Harbor" }
        ).document
      )
      const weather = yield* note("Weather", "Rain all week.")
      const leg = yield* note("Tobin's leg", "Tobin limps.", { condition: { when: "turn", card: tobin } })
      const state = (data: StateEventData) =>
        writer.AddStateEvent({ userId: me.id, chatId: chat.id, slotId: null, versionId: null, scope: null, data })
      yield* state({ key: "note.activate", value: { note: weather.entityId } })
      yield* state({ key: "note.activate", value: { note: leg.entityId } })
      yield* state({ key: "lorebook.attach", value: { ref: book.ref.id } })

      const done = (versionId: VersionId) =>
        Effect.andThen(
          eventually(() => finished(events, versionId) !== undefined),
          () => api.GetRunContext({ versionId })
        )
      const leaf = () => Effect.map(api.GetChat({ chatId: chat.id }), (c) => c.activeLeafSlotId as SlotId)

      // A swipe of the first reply opens its own request.
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
      const reply = path.entries.find((e) => e.version.id === first.id)!
      const swipe = yield* api.Regenerate({ slotId: reply.slotId, expectedRowVersion: reply.rowVersion })
      const swiped = yield* done(swipe.version.id)
      assert.strictEqual(swiped.type, "swipe")
      assert.strictEqual(swiped.capture, "captured")
      // A prompt its ST triggers leave out of a swipe is listed like one its condition left out.
      assert.isTrue(
        swiped.notSent!.some(
          (s) => s.kind === "preset" && s.label === "Preset prompt “Fresh only” (sent only for normal generations)"
        )
      )

      // Removing the earlier swipe renumbers the surviving swipe in this fork.
      const removed = yield* writer.DeleteVersion({
        userId: me.id,
        versionId: first.id,
        forkId: chat.currentForkId
      })
      const sent = yield* posted(
        api.SendMessage({
          chatId: chat.id,
          parentSlotId: yield* leaf(),
          branch: false,
          content: "The lighthouse is dark."
        })
      )
      const next = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const run = yield* done(next.entry.version.id)

      // A preset prompt by its name, linked to the preset.
      const main = sourceOf(run, (l) => l === "Preset prompt “Main Prompt”")!
      assert.strictEqual(main.kind, "preset")
      assert.isString(main.ref)
      assert.lengthOf(
        partTexts(run, (l) => l === "Preset prompt “Main Prompt”"),
        1
      )
      // A card field, its text as sent, linked to the card.
      const mira = sourceOf(run, (l) => l === "Card “Mira”: description")!
      assert.isString(mira.ref)
      assert.deepStrictEqual(
        partTexts(run, (l) => l === "Card “Mira”: description"),
        ["Mira keeps the ledger for Tobin."]
      )
      // A note.
      assert.deepStrictEqual(
        partTexts(run, (l) => l === "Note “Weather”"),
        ["Rain all week."]
      )
      // A lorebook entry by its book, uid and title.
      const lore = sourceOf(run, (l) => l.startsWith("Lorebook “Harbor”"))!
      assert.strictEqual(lore.label, "Lorebook “Harbor”: entry 3 “The lighthouse”")
      assert.strictEqual(lore.ref, book.ref.id)
      assert.deepStrictEqual(
        partTexts(run, (l) => l === lore.label),
        ["The lighthouse burns whale oil."]
      )
      // The surviving swipe is version 1, matching the counter after deletion.
      const history = run.messages.flatMap((m) => m.sources).find((s) => s.slotId === reply.slotId)!
      assert.strictEqual(history.kind, "message")
      assert.strictEqual(history.version, 1)
      assert.deepStrictEqual(
        partTexts(run, (l) => l === history.label),
        ["The lamp gutters."]
      )
      // The note whose condition didn't hold is listed as not sent, with why.
      const skipped = run.notSent!.find((s) => s.label === "Note “Tobin's leg”")!
      assert.deepStrictEqual(skipped.activation, {
        kind: "note",
        activation: "explicit",
        interval: null,
        userMessages: null,
        condition: "on Tobin's turn",
        due: false
      })
      assert.isFalse(run.messages.some((m) => m.content.includes("Tobin limps.")))
      // Parts sit in the blocks they belong to: the card's wrapped field in the characters'
      // definitions, its wrappers as framing; a format prompt holds the card it read by macro.
      const blocks = (label: string) =>
        run.messages.flatMap((m) =>
          (m.groups ?? []).flatMap((g) => (m.sources[g.source]!.label === label ? [{ m, g }] : []))
        )
      const inside = (label: string) => {
        const [found] = blocks(label)
        assert.isDefined(found, label)
        const { m, g } = found!
        return {
          parts: (m.parts ?? [])
            .filter((p) => p.start >= g.start && p.end <= g.end)
            .map((p) => [m.sources[p.source]!.label, m.content.slice(p.start, p.end), p.frame ?? false]),
          groups: (m.groups ?? [])
            .filter((o) => o !== g && o.start >= g.start && o.end <= g.end)
            .map((o) => m.sources[o.source]!.label)
        }
      }
      // The persona's wrapped description is its own turn before the character's.
      assert.deepStrictEqual(
        partTexts(run, (l) => l === "Persona “Tobin”: description"),
        ["Tobin draws maps."]
      )
      const persona = blocks("Tobin's persona")
      assert.lengthOf(persona, 1)
      assert.strictEqual(persona[0]!.m.content, "<Tobin>\nTobin draws maps.\n</Tobin>")
      assert.include(
        blocks("The characters' descriptions").flatMap(({ m, g }) =>
          (m.groups ?? [])
            .filter((o) => o !== g && o.start >= g.start && o.end <= g.end)
            .map((o) => m.sources[o.source]!.label)
        ),
        "Mira's description"
      )
      assert.deepStrictEqual(
        inside("Mira's description").parts.map(([label, , frame]) => [label, frame]),
        [
          ["Preset: card join prefix", true],
          ["Card “Mira”: description", false],
          ["Preset: card join suffix", true]
        ]
      )
      const format = inside("Preset: personality format")
      assert.deepStrictEqual(format.groups, ["The characters' personalities", "Mira's personality"])
      assert.deepStrictEqual(
        format.parts.filter(([, , frame]) => !frame),
        [["Card “Mira”: personality", "Dry and careful.", false]]
      )
      // Parts never overlap, and each is the text at its offsets.
      for (const m of run.messages) {
        const parts = m.parts ?? []
        for (let i = 1; i < parts.length; i++) assert.isAtLeast(parts[i]!.start, parts[i - 1]!.end)
      }

      // Generating again after the reply: the request ends on the end-of-request message.
      const again = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: yield* leaf(), branch: false }))
      const closing = yield* done(again.entry.version.id)
      const last = closing.messages.at(-1)!
      assert.strictEqual(last.role, "user")
      assert.isTrue(
        last.sources.some((s) => s.kind === "preset" && s.label === "End of request: when a character speaks")
      )

      // Writing as the user's card: the prompt conditioned on a character's turn isn't sent.
      const own = yield* posted(
        api.Generate({ chatId: chat.id, parentSlotId: yield* leaf(), branch: false, speakerEntityId: tobin })
      )
      const impersonated = yield* done(own.entry.version.id)
      assert.strictEqual(impersonated.type, "impersonate")
      assert.isTrue(
        impersonated.notSent!.some(
          (s) =>
            s.kind === "preset" && s.label === "Preset prompt “No impersonation” (sent when writing as a character)"
        )
      )
      // ...and the request ends on the text for the user's card.
      assert.isTrue(
        impersonated.messages
          .at(-1)!
          .sources.some((s) => s.kind === "preset" && s.label === "End of request: when your card speaks")
      )
      // ...and the note conditioned on Tobin's turn is sent.
      assert.deepStrictEqual(
        partTexts(impersonated, (l) => l === "Note “Tobin's leg”"),
        ["Tobin limps."]
      )

      // Restoring a preceding swipe changes today's counter, never an earlier capture or
      // its pinned reconstruction. A later capture uses the restored counter instead.
      yield* api.RestoreBinItem({ itemId: removed.id })
      const versions = yield* api.ListVersions({ slotId: reply.slotId, forkId: chat.currentForkId })
      assert.strictEqual(versions.findIndex((v) => v.id === swipe.version.id) + 1, 2)
      assert.deepStrictEqual(yield* api.GetRunContext({ versionId: next.entry.version.id }), run)
      const [payloads] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: "SELECT context_snapshot_json FROM rollout_payloads WHERE rollout_id = (SELECT rollout_id FROM versions WHERE id = ?)",
            params: [next.entry.version.id]
          }
        ],
        { readOnly: true }
      )
      const snapshot = payloads![0]!.context_snapshot_json as string
      const rebuilt = yield* (yield* Reader).RebuildContext({ userId: me.id, snapshot })
      assert.strictEqual(rebuilt._tag, "Rebuilt")
      if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), JSON.parse(snapshot))
      const restoredReply = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: yield* leaf(), branch: false }))
      const restoredRun = yield* done(restoredReply.entry.version.id)
      assert.strictEqual(
        restoredRun.messages.flatMap((m) => m.sources).find((s) => s.slotId === reply.slotId)!.version,
        2
      )
      yield* writer.DeleteVersion({ userId: me.id, versionId: first.id, forkId: chat.currentForkId })
      assert.deepStrictEqual(yield* api.GetRunContext({ versionId: restoredReply.entry.version.id }), restoredRun)

      // A capture from before parts were recorded still opens, verbatim, with its sources.
      yield* fixtureSql(config.dataDir, [
        {
          sql: `UPDATE rollout_payloads SET sent_context_json = (
              SELECT json_set(json_remove(sent_context_json, '$.display.notSent'), '$.messages',
                (SELECT json_group_array(json_remove(m.value, '$.parts')) FROM json_each(sent_context_json, '$.messages') m))
            ) WHERE rollout_id = (SELECT rollout_id FROM versions WHERE id = ?)`,
          params: [next.entry.version.id]
        }
      ])
      const old = yield* api.GetRunContext({ versionId: next.entry.version.id })
      assert.strictEqual(old.capture, "captured")
      assert.deepStrictEqual(
        old.messages.map((m) => [m.content, m.sources.map((s) => s.label)]),
        run.messages.map((m) => [m.content, m.sources.map((s) => s.label)])
      )
      assert.isTrue(old.messages.every((m) => m.parts === undefined))
      assert.isUndefined(old.notSent)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  },
  { timeout: 180_000 }
)
