// Synthetic ST folders: arrival in ST is distinct from the author's creation and file edits.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl } from "./support/stFolder.ts"
import { importStFolder, importStPath, sendStFile } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"
import { cardV3, png } from "./formats/support.ts"

const ARRIVED = Date.UTC(2022, 1, 3)
const AUTHORED = Date.UTC(2020, 0, 1)
const FILE = Date.UTC(2025, 5, 14)
const PERSONA = `${ARRIVED + 1000}-Sam.png`
const GROUP = String(ARRIVED + 2000)
const msg = (name: string, at: number, more = {}) => ({ name, mes: `${name} ${at}`, send_date: at, ...more })
const config = testConfig()
const view = {
  entity: null,
  chat: null,
  search: "",
  sort: "added" as const,
  sections: [{ id: "groups" as const, limit: 100 }]
}
const doc = (name: string, added: number) =>
  encode({ ...cardV3(), create_date: added, data: { ...cardV3().data, name, creation_date: AUTHORED / 1000 } })
const files = (tag: string) =>
  new Map([
    [`characters/${tag}.json`, doc(tag, ARRIVED)],
    [`characters/${tag} B.json`, doc(`${tag} B`, ARRIVED + 500)],
    [
      "settings.json",
      encode({
        power_user: {
          personas: { [PERSONA]: `${tag} persona` },
          persona_descriptions: { [PERSONA]: { description: "Synthetic", position: 0 } }
        }
      })
    ],
    [`User Avatars/${PERSONA}`, png()],
    [`groups/${GROUP}.json`, encode({ id: GROUP, name: tag, members: [`${tag}.json`, `${tag} B.json`], chats: [tag] })],
    [
      `group chats/${tag}.jsonl`,
      jsonl([
        header({}),
        // Archived messages can predate this ST installation. Saved arrival metadata wins.
        msg(tag, AUTHORED, { original_avatar: `${tag}.json` }),
        msg("Sam", AUTHORED + 1000, { is_user: true, force_avatar: `User Avatars/${PERSONA}` }),
        msg(`${tag} B`, AUTHORED + 2000, { original_avatar: `${tag} B.json` })
      ])
    ]
  ])
const check = Effect.fnUntraced(function* (tag: string) {
  const api = yield* client()
  const shell = yield* api.GetShellCards()
  const a = shell.cards.find((c) => c.card.name === tag)!
  const persona = (yield* api.ListLibrary({ kind: "card" })).find((c) => c.label === `${tag} persona`)!
  assert.strictEqual(a.createdAt, AUTHORED)
  assert.strictEqual(a.addedAt, ARRIVED)
  assert.strictEqual(persona.addedAt, ARRIVED + 1000)
  const groups = yield* api.GetShellForks(view)
  const group = groups.sections[0]!.rows.find((g) => g.chatName === tag)!
  assert.isDefined(group)
  assert.strictEqual(group.addedAt, ARRIVED + 2000)
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("ST Added dates", (it) => {
  it.effect(
    "uploads inherit card, persona and group arrival metadata while CCv3 Created remains the author's date",
    () =>
      Effect.gen(function* () {
        const folder = files("Arrival upload")
        yield* importStFolder(folder, {
          modifiedAt: new Map([...folder.keys()].map((path) => [path, FILE])),
          partBytes: 350
        })
        yield* check("Arrival upload")
      })
  )

  it.effect("disk imports use the same source dates despite fresh filesystem creation and later edits", () =>
    Effect.gen(function* () {
      const root = tempDir("st-added")
      for (const [path, bytes] of files("Arrival disk")) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), bytes)
        utimesSync(join(root, path), new Date(FILE), new Date(FILE))
      }
      const onlyFile = join(root, "characters", "Disk file only.png")
      writeFileSync(onlyFile, card("Disk file only", "Hello"))
      utimesSync(onlyFile, new Date(FILE), new Date(FILE))
      const result = yield* importStPath(yield* client(), root)
      assert.strictEqual(result.job.status, "complete")
      yield* check("Arrival disk")
      assert.strictEqual(
        (yield* (yield* client()).GetShellCards()).cards.find((c) => c.card.name === "Disk file only")!.addedAt,
        FILE
      )
    })
  )

  it.effect("missing metadata uses actual message dates before file dates, shared across a group's chats", () =>
    Effect.gen(function* () {
      const tag = "Fallback arrival"
      const folder = new Map([
        [`characters/${tag}.png`, card(tag, "Hello")],
        [`characters/${tag} B.png`, card(`${tag} B`, "Hello")],
        ["User Avatars/unknown.png", png()],
        ["settings.json", encode({ power_user: { personas: { "unknown.png": "Fallback persona" } } })],
        [
          "groups/fallback.json",
          encode({
            id: "fallback",
            name: "Fallback group",
            members: [`${tag}.png`, `${tag} B.png`],
            chats: ["later", "older"]
          })
        ],
        [
          "group chats/later.jsonl",
          jsonl([
            header({}),
            msg(tag, ARRIVED + 10000, { original_avatar: `${tag}.png` }),
            msg("Fallback persona", ARRIVED + 11000, { is_user: true, force_avatar: "User Avatars/unknown.png" }),
            msg(`${tag} B`, ARRIVED + 12000, { original_avatar: `${tag} B.png` })
          ])
        ],
        [
          "group chats/older.jsonl",
          jsonl([
            header({}),
            msg(tag, ARRIVED, { original_avatar: `${tag}.png` }),
            msg("Fallback persona", ARRIVED + 1000, { is_user: true, force_avatar: "User Avatars/unknown.png" }),
            msg(`${tag} B`, ARRIVED + 2000, { original_avatar: `${tag} B.png` })
          ])
        ],
        ["characters/Only file.png", card("Only file", "Hi")],
        // Thumbnails are cache artifacts, ignored even when they have a much earlier date.
        ["thumbnails/avatar/Only file.png", png()]
      ])
      const times = new Map([...folder.keys()].map((path) => [path, path.includes("Only file") ? FILE : AUTHORED]))
      const { api } = yield* importStFolder(folder, { modifiedAt: times, partBytes: 350 })
      const shell = yield* api.GetShellCards()
      const a = shell.cards.find((c) => c.card.name === tag)!
      assert.strictEqual(a.addedAt, ARRIVED)
      assert.strictEqual(a.createdAt, ARRIVED) // Original authorship is unavailable: same evidence.
      assert.strictEqual(
        (yield* api.ListLibrary({ kind: "card" })).find((c) => c.label === "Fallback persona")!.addedAt,
        ARRIVED + 1000
      )
      assert.strictEqual(shell.cards.find((c) => c.card.name === "Only file")!.addedAt, FILE)
      const groups = (yield* api.GetShellForks(view)).sections[0]!.rows.filter((g) =>
        ["later", "older"].includes(g.chatName)
      )
      assert.lengthOf(groups, 2)
      assert.isTrue(groups.every((g) => g.addedAt === ARRIVED))
      // A later file imported after the oldest chat must inherit the same known group date.
      folder.set(
        "group chats/newer.jsonl",
        jsonl([
          header({}),
          msg(tag, ARRIVED + 50000, { original_avatar: `${tag}.png` }),
          msg(`${tag} B`, ARRIVED + 51000, { original_avatar: `${tag} B.png` })
        ])
      )
      const definition = JSON.parse(new TextDecoder().decode(folder.get("groups/fallback.json")!))
      folder.set("groups/fallback.json", encode({ ...definition, chats: ["later", "older", "newer"] }))
      yield* importStFolder(folder, { modifiedAt: times })
      assert.isTrue(
        (yield* api.GetShellForks(view)).sections[0]!.rows.filter((g) =>
          ["later", "older", "newer"].includes(g.chatName)
        ).every((g) => g.addedAt === ARRIVED)
      )
      // Added sorting is distinct from the newer chat/fork creation and supports reversal.
      const dates = (yield* api.GetShellForks(view)).sections[0]!.rows.map((g) => g.addedAt!)
      assert.deepStrictEqual(
        dates,
        [...dates].sort((a, b) => b - a)
      )
      assert.deepStrictEqual(
        (yield* api.GetShellForks({ ...view, reversed: true })).sections[0]!.rows.map((g) => g.addedAt!),
        [...dates].reverse()
      )
    })
  )

  it.effect("reimports keep earliest metadata without extra revisions; manual imports and new cards use now", () =>
    Effect.gen(function* () {
      const path = "characters/Stable arrival.json"
      const { api } = yield* importStFolder(new Map([[path, doc("Stable arrival", ARRIVED)]]))
      const before = (yield* api.GetShellCards()).cards.find((c) => c.card.name === "Stable arrival")!
      yield* importStFolder(new Map([[path, doc("Stable arrival", ARRIVED + 100000)]]))
      yield* importStFolder(new Map([[path, doc("Stable arrival", ARRIVED + 100000)]]))
      const after = (yield* api.GetShellCards()).cards.find((c) => c.card.name === "Stable arrival")!
      assert.strictEqual(after.addedAt, ARRIVED)
      assert.strictEqual(after.createdAt, AUTHORED)
      assert.lengthOf(yield* api.ListRevisions({ refId: before.card.refId, limit: 10 }), 1)
      const now = Date.now()
      const port = yield* serverPort
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/library/import?name=Manual.json`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: doc("Manual arrival", ARRIVED)
        })
      )
      assert.strictEqual(response.status, 200)
      yield* api.CreateCard({ label: "Native arrival", name: "Native arrival" })
      const current = yield* api.GetShellCards()
      for (const name of ["Manual arrival", "Native arrival"])
        assert.isAtLeast(current.cards.find((c) => c.card.name === name)!.addedAt, now)
      const manual = current.cards.find((c) => c.card.name === "Manual arrival")!
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      yield* sendStFile(
        importId,
        "chats/Unmatched/manual.jsonl",
        jsonl([header({}), msg("Manual arrival", AUTHORED), msg("User", AUTHORED + 1000, { is_user: true })]),
        { card: manual.card.entityId }
      )
      assert.isAtLeast(
        (yield* api.GetShellCards()).cards.find((c) => c.card.entityId === manual.card.entityId)!.addedAt,
        now
      )
      const discovered = "characters/Later authorship.png"
      yield* importStFolder(new Map([[discovered, card("Later authorship", "Hi", {}, {}, { create_date: ARRIVED })]]))
      yield* importStFolder(
        new Map([
          [discovered, card("Later authorship", "Hi", {}, { creation_date: AUTHORED / 1000 }, { create_date: ARRIVED })]
        ])
      )
      const refined = (yield* api.GetShellCards()).cards.find((c) => c.card.name === "Later authorship")!
      assert.strictEqual(refined.addedAt, ARRIVED)
      assert.strictEqual(refined.createdAt, AUTHORED)
      const undated = "characters/Unknown arrival.png"
      yield* importStFolder(new Map([[undated, card("Unknown arrival", "Hi")]]))
      assert.isAtLeast((yield* api.GetShellCards()).cards.find((c) => c.card.name === "Unknown arrival")!.addedAt, now)
    })
  )
})
