// All fixtures are synthetic. Dates distinguish file edits from imports and chat activity.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder, importStPath, sendStFile } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"
import { cardV3, png, zip } from "./formats/support.ts"

const config = testConfig()
const FILE = Date.UTC(2024, 5, 14, 12, 30)
const SETTINGS = FILE + 60_000
const INNER = FILE - 86_400_000
const CREATED = Date.UTC(2022, 0, 1)
const SENT = Date.UTC(2025, 0, 1, 10, 2)
const preset = (temperature = 0.7, content = String(temperature)) =>
  encode({ temperature, prompts: [{ identifier: "main", content }], prompt_order: [] })

const folder = (tag: string) =>
  new Map([
    [
      "settings.json",
      encode({
        power_user: {
          personas: { "user.png": `${tag} persona` },
          persona_descriptions: { "user.png": { description: "Synthetic persona", position: 4, depth: 2, role: 0 } },
          pin_examples: true
        },
        extension_settings: { note: { chara: [{ name: tag, prompt: "Settings note", useChara: true }] } }
      })
    ],
    ["User Avatars/user.png", png()],
    [
      `characters/${tag}.png`,
      card(
        tag,
        "Hello",
        {
          depth_prompt: { prompt: "Card note", depth: 4, role: "system" }
        },
        {},
        { create_date: new Date(CREATED).toISOString(), date_last_chat: SENT + 999999 }
      )
    ],
    [
      `characters/${tag}-v3.json`,
      encode({
        ...cardV3(),
        data: { ...cardV3().data, name: `${tag} v3`, modification_date: INNER / 1000, creation_date: CREATED / 1000 }
      })
    ],
    [
      `characters/${tag}-charx.charx`,
      zip([
        {
          name: "card.json",
          data: encode({
            ...cardV3(),
            data: { ...cardV3().data, name: `${tag} charx`, modification_date: 0 }
          })
        }
      ])
    ],
    [
      `worlds/${tag}.json`,
      encode({ entries: { "0": { uid: 0, key: [tag], content: "Synthetic lore", enabled: true } } })
    ],
    [`OpenAI Settings/${tag}.json`, preset(0.7, tag)],
    [
      `groups/${tag}.json`,
      encode({
        id: tag,
        name: `${tag} group`,
        members: [`${tag}.png`],
        chats: [tag],
        chat_id: tag,
        date_last_chat: SENT + 999999
      })
    ],
    [
      `group chats/${tag}.jsonl`,
      jsonl([
        header({ note_prompt: "Chat note", note_position: 1, note_depth: 4 }),
        message({ name: tag, mes: "First", minute: 0, memory: "Earlier summary" }),
        message({ name: "User", user: true, mes: "Second", minute: 1, memory: "Later summary" }),
        message({ name: tag, mes: "Third", minute: 2 })
      ])
    ]
  ])

const checkFolder = Effect.fnUntraced(function* (tag: string, before: number) {
  const api = yield* client()
  const refs = (yield* Effect.all(
    ["card", "preset", "lorebook", "note"].map((kind) =>
      api.ListLibrary({ kind: kind as "card" | "preset" | "lorebook" | "note" })
    )
  )).flat()
  for (const [label, expected] of [
    [tag, FILE],
    [`${tag} v3`, INNER],
    [`${tag} charx`, FILE],
    [`${tag} persona`, SETTINGS],
    [tag, SETTINGS]
  ] as const) {
    const ref = refs.find(
      (r) => r.label === label && (label === tag ? r.kind === (expected === FILE ? "card" : "preset") : true)
    )!
    assert.isDefined(ref, label)
    assert.strictEqual(ref.updatedAt, expected, `${label}: modified`)
    assert.strictEqual(
      (yield* api.ListRevisions({ refId: ref.id, limit: 10 }))[0]!.createdAt,
      expected,
      `${label}: history`
    )
  }
  const book = refs.find((r) => r.kind === "lorebook" && r.label === tag)!
  assert.strictEqual(book.updatedAt, FILE)
  const user = yield* api.Whoami()
  const chat = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats.find(
    (c) => c.source === `group chats/${tag}.jsonl`
  )!
  const path = yield* api.ReadPath({ chatId: chat.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
  assert.strictEqual(path.entries.at(-1)!.version.createdAt, SENT)
  const [notes, entities] = yield* fixtureSql(
    config.dataDir,
    [
      {
        sql: `SELECT r.label, h.created_at, h.doc_json FROM entity_refs r JOIN entity_revisions h ON h.entity_id = r.entity_id
        WHERE (json_extract(h.doc_json, '$.owner.card') IN
          (SELECT entity_id FROM entity_refs WHERE label IN (?, ?))
          OR json_extract(h.doc_json, '$.owner.chat') = ?) AND h.origin = 'import'`,
        params: [tag, `${tag} persona`, chat.chatId]
      },
      {
        sql: `SELECT e.kind, e.created_at FROM entities e JOIN entity_refs r ON r.entity_id = e.id WHERE r.label = ?`,
        params: [tag]
      }
    ],
    { readOnly: true }
  )
  assert.isTrue(notes!.some((n) => n.label === "Character's Note" && n.created_at === FILE))
  assert.isTrue(
    notes!.some((n) => JSON.parse(n.doc_json as string).title === "Persona description" && n.created_at === SETTINGS)
  )
  assert.isTrue(notes!.some((n) => n.label === "Character author's note" && n.created_at === SETTINGS))
  assert.isTrue(notes!.some((n) => n.label === "Author's Note" && n.created_at === FILE))
  assert.deepStrictEqual(
    notes!
      .filter((n) => n.label === "Summary (from ST)")
      .map((n) => n.created_at)
      .sort(),
    [SENT - 120_000, SENT - 60_000]
  )
  assert.strictEqual(entities!.find((e) => e.kind === "card")!.created_at, CREATED)
  assert.isAtLeast(entities!.find((e) => e.kind === "preset")!.created_at as number, before)
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })(
  "ST source modification times",
  (it) => {
    it.effect("browser folder uploads retain per-file dates, settings dates, message dates and creation dates", () =>
      Effect.gen(function* () {
        const files = folder("Upload times")
        const modifiedAt = new Map([...files.keys()].map((path) => [path, path === "settings.json" ? SETTINGS : FILE]))
        const before = Date.now()
        const result = yield* importStFolder(files, { modifiedAt, partBytes: 500 })
        assert.strictEqual(result.report.counts.preset?.added, 1)
        yield* checkFolder("Upload times", before)
      })
    )

    it.effect("server folder imports carry stat mtime instead of filesystem ctime or import time", () =>
      Effect.gen(function* () {
        const root = tempDir("st-times")
        for (const [path, bytes] of folder("Disk times")) {
          const full = join(root, path)
          mkdirSync(dirname(full), { recursive: true })
          writeFileSync(full, bytes)
          const at = new Date(path === "settings.json" ? SETTINGS : FILE)
          utimesSync(full, at, at)
        }
        const before = Date.now()
        const { job, notSent } = yield* importStPath(yield* client(), root)
        assert.strictEqual(job.status, "complete")
        assert.deepStrictEqual(notSent, [])
        yield* checkFolder("Disk times", before)
      })
    )

    it.effect("reimports use the new source date, retain history order and leave unchanged revisions alone", () =>
      Effect.gen(function* () {
        const path = "OpenAI Settings/Reimport times.json"
        const first = yield* importStFolder(new Map([[path, preset()]]), { modifiedAt: new Map([[path, FILE]]) })
        const ref = (yield* first.api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Reimport times")!
        const writer = yield* Writer
        const user = yield* first.api.Whoami()
        const follower = yield* writer.ForkRef({
          userId: user.id,
          refId: ref.id,
          label: "Times follower",
          subtitle: ""
        })
        const second = yield* importStFolder(new Map([[path, preset(0.8)]]), { modifiedAt: new Map([[path, INNER]]) })
        assert.strictEqual(second.answers.get(path)!.outcome, "updated")
        const after = (yield* first.api.OpenEditor({ refId: ref.id })).ref
        assert.strictEqual(after.updatedAt, INNER)
        assert.strictEqual((yield* first.api.OpenEditor({ refId: follower.id })).ref.updatedAt, INNER)
        assert.deepStrictEqual(
          (yield* first.api.ListRevisions({ refId: ref.id, limit: 10 })).map((r) => r.createdAt),
          [INNER, FILE]
        )
        yield* importStFolder(new Map([[path, preset(0.8)]]), { modifiedAt: new Map([[path, FILE + 99999]]) })
        assert.strictEqual((yield* first.api.OpenEditor({ refId: ref.id })).ref.updatedAt, INNER)
        assert.lengthOf(yield* first.api.ListRevisions({ refId: ref.id, limit: 10 }), 2)
      })
    )

    it.effect("local edits and merges keep their own dates while the imported revision retains its source date", () =>
      Effect.gen(function* () {
        const path = "OpenAI Settings/Local time.json"
        const { api } = yield* importStFolder(new Map([[path, preset(0.4)]]), { modifiedAt: new Map([[path, FILE]]) })
        const ref = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Local time")!
        const opened = yield* api.OpenEditor({ refId: ref.id })
        const user = yield* api.Whoami()
        const before = Date.now()
        yield* (yield* Writer).EditRef({
          userId: user.id,
          refId: ref.id,
          expectedRowVersion: opened.ref.rowVersion,
          doc: {
            ...opened.doc,
            extensions: { ...(opened.doc.extensions as Record<string, unknown>), local: "A local instruction" }
          },
          message: null,
          commitDraft: null
        })
        assert.isAtLeast((yield* api.OpenEditor({ refId: ref.id })).ref.updatedAt, before)
        yield* importStFolder(new Map([[path, preset(0.9)]]), { modifiedAt: new Map([[path, INNER]]) })
        const after = yield* api.OpenEditor({ refId: ref.id })
        assert.isAtLeast(after.ref.updatedAt, before)
        const revisions = yield* api.ListRevisions({ refId: ref.id, limit: 10 })
        assert.strictEqual(revisions[0]!.origin, "merge")
        assert.isAtLeast(revisions[0]!.createdAt, before)
        assert.strictEqual((after.doc.extensions as Record<string, unknown>).local, "A local instruction")
        const [imports] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT created_at FROM entity_revisions WHERE entity_id = ? AND origin = 'import' ORDER BY seq DESC",
              params: [ref.entityId]
            }
          ],
          { readOnly: true }
        )
        assert.deepStrictEqual(
          imports!.map((r) => r.created_at),
          [INNER, FILE]
        )
      })
    )

    it.effect("missing and invalid source dates fall back to import time", () =>
      Effect.gen(function* () {
        const api = yield* client()
        const before = Date.now()
        const { importId } = yield* api.StartStImport({ unsupported: [] })
        for (const [i, modifiedAt] of [undefined, "", "NaN", "Infinity", "-1", "9000000000000000"].entries()) {
          const path = `OpenAI Settings/Unknown time ${i}.json`
          const sent = yield* sendStFile(
            importId,
            path,
            preset(0.1 + i / 10),
            modifiedAt === undefined ? {} : { modifiedAt }
          )
          assert.strictEqual(sent.outcome, "added")
          const ref = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === `Unknown time ${i}`)!
          assert.isAtLeast(ref.updatedAt, before)
          assert.isAtMost(ref.updatedAt, Date.now())
        }
        const path = "group chats/Undated messages.jsonl"
        yield* sendStFile(
          importId,
          path,
          jsonl([header({}), { name: "User", is_user: true, mes: "Undated one" }, { name: "Bot", mes: "Undated two" }]),
          { modifiedAt: String(FILE) }
        )
        const user = yield* api.Whoami()
        const record = (yield* (yield* Reader).StImportSources({ userId: user.id })).chats.find(
          (c) => c.source === path
        )!
        const messages = yield* api.ReadPath({
          chatId: record.chatId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 10
        })
        assert.deepStrictEqual(
          messages.entries.map((e) => e.version.createdAt),
          [FILE, FILE]
        )
      })
    )
  }
)
