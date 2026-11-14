// Independent fixtures: duplicate character names, named branches, real-account boundaries,
// native downloads and cancellation. ST 1.19 group-chats.js identifies speakers by avatar,
// not display name; bookmarks.js keeps child filenames in the split message's extra.branches.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { client, post, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"
import { Writer } from "../src/db/Database.ts"
import { extract, readZip } from "../src/formats/zip.ts"
import { defaultLimits } from "../src/formats/safety.ts"
import { importCard } from "../src/formats/cardImport.ts"
import { worldInfo } from "./formats/support.ts"

const archive = new Map<string, Uint8Array>()
const emptyArchive = new Map<string, Uint8Array>()
const speakerTexts = new Map<string, string>()
const lines = [
  message({
    name: "Twin",
    mes: "One speaks.",
    minute: 1,
    avatar: "One.png",
    swipes: Array.from({ length: 50 }, (_, i) => (i === 31 ? "One speaks." : `Take ${i}`)),
    swipeId: 31,
    reasoning: "Synthetic private reasoning."
  }),
  message({ name: "Twin", mes: "Two speaks.", minute: 2, avatar: "Two.png" })
]
const folder = new Map([
  ["characters/One.png", card("Twin", "First greeting.")],
  ["characters/Two.png", card("Twin", "Other greeting.")],
  [
    "groups/g.json",
    encode({
      id: "g",
      name: "Twins",
      members: ["One.png", "Two.png"],
      chats: ["Main", "Alternate"],
      chat_id: "Alternate"
    })
  ],
  ["group chats/Main.jsonl", jsonl([header({}), ...lines])],
  [
    "group chats/Alternate.jsonl",
    jsonl([
      header({ main_chat: "Main" }),
      lines[0],
      message({ name: "Twin", mes: "Alternate second.", minute: 3, avatar: "Two.png" })
    ])
  ]
])

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "120 seconds" })("adversarial export", (it) => {
  it.effect("preserves duplicate-name group speakers, current branch, named files and parent navigation", () =>
    Effect.gen(function* () {
      const { api } = yield* importStFolder(folder)
      const chat = (yield* api.ListChats({ limit: 20, before: null }))[0]!
      const forks = yield* api.ListForks({ chatId: chat.id })
      assert.strictEqual(forks.length, 2)
      const child = forks.find((f) => f.parentForkId !== null)!
      // NameFork is the same operation the branch row uses.
      yield* api.NameFork({ forkId: child.id, name: "A/B: 🌒" })
      for (const f of forks) {
        const page = yield* api.ReadPath({
          chatId: chat.id,
          forkId: f.id,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 100
        })
        for (const e of page.entries) speakerTexts.set(e.version.content, e.version.speakerEntityId!)
      }
      const response = yield* post("/library/archive", {})
      assert.strictEqual(response.status, 200)
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const budget = { used: 0 }
      for (const [name, entry] of readZip(bytes, defaultLimits))
        archive.set(name, extract(bytes, entry, defaultLimits, budget))
      const groups = [...archive].filter(([name]) => name.startsWith("groups/"))
      const group = JSON.parse(new TextDecoder().decode(groups[0]![1]))
      const branchFile = [...archive.keys()].find((n) => n.includes("A_B_ 🌒"))!
      assert.isDefined(branchFile, [...archive.keys()].join(", "))
      assert.strictEqual(`group chats/${group.chat_id}.jsonl`, branchFile)
      const chatLines = (name: string) =>
        new TextDecoder()
          .decode(archive.get(name)!)
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s))
      const branch = chatLines(branchFile)
      const parent = chatLines(`group chats/${branch[0].chat_metadata.main_chat}.jsonl`)
      assert.isString(parent[1].original_avatar)
      assert.notStrictEqual(parent[1].original_avatar, parent[2].original_avatar)
      assert.include(parent[1].extra.branches, branchFile.slice("group chats/".length, -6))
      assert.strictEqual(branch[2].original_avatar, parent[2].original_avatar)
      if (process.env.REVIEW_EXPORT_OUT) {
        for (const [name, data] of archive) {
          const path = join(process.env.REVIEW_EXPORT_OUT, name)
          mkdirSync(join(path, ".."), { recursive: true })
          writeFileSync(path, data)
        }
      }
    })
  )
  it.effect("keeps card world links pointing to sanitised archive filenames", () =>
    Effect.gen(function* () {
      const other = worldInfo()
      other.entries["3"].content = "A different, colliding world."
      const composed = worldInfo()
      composed.entries["3"].content = "Composed world."
      const decomposed = worldInfo()
      decomposed.entries["3"].content = "Decomposed world."
      yield* importStFolder(
        new Map([
          ["characters/Bound.png", card("Bound", "Hello.", { world: "CON" })],
          ["worlds/CON.json", encode(worldInfo())],
          ["worlds/_CON.json", encode(other)],
          ["characters/Composed.png", card("Composed", "Hello.", { world: "é" })],
          ["characters/Decomposed.png", card("Decomposed", "Hello.", { world: "e\u0301" })],
          ["worlds/é.json", encode(composed)],
          ["worlds/e\u0301.json", encode(decomposed)]
        ])
      )
      const response = yield* post("/library/archive", {})
      assert.strictEqual(response.status, 200)
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const entries = readZip(bytes, defaultLimits)
      const budget = { used: 0 }
      for (const [name, expected] of [
        ["Bound", "The harbor freezes in winter."],
        ["Composed", "Composed world."],
        ["Decomposed", "Decomposed world."]
      ]) {
        const parsed = yield* importCard(extract(bytes, entries.get(`characters/${name}.png`)!, defaultLimits, budget))
        const world = parsed.card.extensions.world
        assert.isString(world)
        assert.isTrue(entries.has(`worlds/${world}.json`), `Missing world ${world}: ${[...entries.keys()].join(", ")}`)
        const linked = JSON.parse(
          new TextDecoder().decode(extract(bytes, entries.get(`worlds/${world}.json`)!, defaultLimits, budget))
        )
        assert.strictEqual(linked.entries["3"].content, expected)
      }
    })
  )
  it.effect("identifies same-name group speakers by ST avatar keys", () =>
    Effect.sync(() => {
      const groupFiles = [...archive].filter(([name]) => name.startsWith("group chats/"))
      assert.strictEqual(groupFiles.length, 2)
      for (const [, bytes] of groupFiles) {
        const data = new TextDecoder()
          .decode(bytes)
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        assert.isString(data[1].original_avatar)
        assert.isString(data[2].original_avatar)
        assert.notStrictEqual(data[1].original_avatar, data[2].original_avatar)
      }
    })
  )
  it.effect("opens the chosen group branch and links it from its parent", () =>
    Effect.sync(() => {
      const read = (bytes: Uint8Array) =>
        new TextDecoder()
          .decode(bytes)
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      const group = JSON.parse(new TextDecoder().decode([...archive].find(([name]) => name.startsWith("groups/"))![1]))
      const [branchName, branchBytes] = [...archive].find(
        ([name, bytes]) => name.startsWith("group chats/") && read(bytes)[0].chat_metadata.main_chat
      )!
      assert.strictEqual(`group chats/${group.chat_id}.jsonl`, branchName)
      const parent = read(archive.get(`group chats/${read(branchBytes)[0].chat_metadata.main_chat}.jsonl`)!)
      assert.include(parent[1].extra.branches, branchName.slice("group chats/".length, -6))
    })
  )
  it.effect("excludes binned chats, messages and versions while keeping the complete visible transcript", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const cards = yield* api.ListLibrary({ kind: "card" })
      const chat = yield* api.CreateChat({ title: "Deletion fixture" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: cards[0]!.entityId } })
      const first = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Binned version sentinel",
        reply: false
      })
      assert.strictEqual(first._tag, "Posted")
      if (first._tag !== "Posted") return
      yield* api.WriteVersion({
        slotId: first.entry.slotId,
        content: "Retained selected version",
        expectedRowVersion: first.entry.rowVersion
      })
      yield* api.DeleteVersion({ versionId: first.entry.version.id })
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        forkId: chat.currentForkId!,
        slotId: first.entry.slotId,
        versionId: null,
        scope: null,
        data: { key: "context.per_speaker", value: "separate" }
      })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: first.entry.slotId,
        change: { _tag: "Away", entityId: cards[0]!.entityId, away: true }
      })
      const deleted = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: first.entry.slotId,
        branch: false,
        content: "Binned message sentinel",
        reply: false
      })
      if (deleted._tag !== "Posted") throw new Error("unexpected queue")
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: deleted.entry.slotId,
        branch: false,
        content: "Spoken while away remains in transcript",
        reply: false
      })
      yield* api.DeleteMessage({ slotId: deleted.entry.slotId })
      const binned = yield* api.CreateChat({ title: "Binned chat sentinel" })
      yield* api.SendMessage({
        chatId: binned.id,
        parentSlotId: null,
        branch: false,
        content: "Binned whole chat text",
        reply: false
      })
      yield* api.DeleteChat({ chatId: binned.id })
      const response = yield* post("/library/archive", {})
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const files = readZip(bytes, defaultLimits)
      const budget = { used: 0 }
      let content = ""
      for (const [name, entry] of files)
        content += name + new TextDecoder().decode(extract(bytes, entry, defaultLimits, budget))
      for (const sentinel of [
        "Binned version sentinel",
        "Binned message sentinel",
        "Binned chat sentinel",
        "Binned whole chat text"
      ])
        assert.notInclude(content, sentinel)
      assert.include(content, "Retained selected version")
      assert.include(content, "Spoken while away remains in transcript")
      assert.notInclude(content, "context.per_speaker")
      assert.strictEqual(
        (yield* post("/library/chat-export", { chatId: binned.id, forkId: null, scope: "branch", format: "jsonl" }))
          .status,
        404
      )
    })
  )
  it.effect("de-duplicates sanitised Unicode branch names and preserves every parent link", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "界".repeat(90) })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Split here",
        reply: false
      })
      if (sent._tag !== "Posted") throw new Error("unexpected queue")
      yield* api.NameFork({ forkId: chat.currentForkId!, name: "CON" })
      for (const name of ["cafe\u0301/🌒", "CAFÉ\\🌒"])
        yield* api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId!, atSlotId: sent.entry.slotId, name })
      const response = yield* post("/library/chat-export", {
        chatId: chat.id,
        forkId: null,
        scope: "all",
        format: "jsonl"
      })
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const files = readZip(bytes, defaultLimits)
      assert.strictEqual(files.size, 3)
      const names = [...files.keys()]
      assert.strictEqual(new Set(names.map((n) => n.normalize("NFC").toLowerCase())).size, 3)
      assert.isTrue(names.some((n) => n.includes("café_🌒")))
      assert.isTrue(names.some((n) => n.includes("CAFÉ_🌒 (2)")))
      const budget = { used: 0 }
      for (const [name, entry] of files) {
        assert.isAtMost(Buffer.byteLength(name), 255)
        const header = JSON.parse(
          new TextDecoder().decode(extract(bytes, entry, defaultLimits, budget)).split("\n")[0]!
        )
        if (header.chat_metadata.main_chat) assert.isTrue(files.has(`${header.chat_metadata.main_chat}.jsonl`))
      }
    })
  )
  it.effect("exports Every branch as a zip even with only one branch", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Single branch family" })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "Only message",
        reply: false
      })
      const response = yield* post("/library/chat-export", {
        chatId: chat.id,
        forkId: null,
        scope: "all",
        format: "jsonl"
      })
      assert.strictEqual(response.headers.get("content-type"), "application/zip")
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      assert.strictEqual(readZip(bytes, defaultLimits).size, 1)
    })
  )
  it.effect("keeps a chat with no characters discoverable in SillyTavern's group list", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "No cast" })
      yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "A transcript with no characters.",
        reply: false
      })
      const response = yield* post("/library/archive", {})
      const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
      const files = readZip(bytes, defaultLimits)
      const groupFile = files.get(`groups/${chat.id}.json`)
      assert.isDefined(groupFile)
      const budget = { used: 0 }
      const group = JSON.parse(new TextDecoder().decode(extract(bytes, groupFile!, defaultLimits, budget)))
      assert.deepStrictEqual(group.members, [])
      assert.isTrue(files.has(`group chats/${group.chat_id}.jsonl`))
      const content = new TextDecoder().decode(
        extract(bytes, files.get(`group chats/${group.chat_id}.jsonl`)!, defaultLimits, budget)
      )
      assert.include(content, "A transcript with no characters.")
      emptyArchive.set("settings.json", encode({ power_user: { personas: {}, persona_descriptions: {} } }))
      for (const path of [`groups/${chat.id}.json`, `group chats/${group.chat_id}.jsonl`])
        emptyArchive.set(path, extract(bytes, files.get(path)!, defaultLimits, { used: 0 }))
      if (process.env.REVIEW_EMPTY_OUT) {
        for (const path of [`groups/${chat.id}.json`, `group chats/${group.chat_id}.jsonl`]) {
          const target = join(process.env.REVIEW_EMPTY_OUT, path)
          mkdirSync(join(target, ".."), { recursive: true })
          writeFileSync(target, extract(bytes, files.get(path)!, defaultLimits, { used: 0 }))
        }
      }
    })
  )
})

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "120 seconds" })(
  "adversarial archive round trip",
  (it) => {
    it.effect("keeps every group branch and duplicate-name speaker distinct in a clean account", () =>
      Effect.gen(function* () {
        assert.isAbove(archive.size, 0)
        const { api, report } = yield* importStFolder(archive)
        assert.deepStrictEqual(report.issues, [])
        const chats = yield* api.ListChats({ limit: 20, before: null })
        assert.strictEqual(chats.length, 1)
        const forks = yield* api.ListForks({ chatId: chats[0]!.id })
        assert.strictEqual(forks.length, 2)
        const ids = new Map<string, string>()
        for (const fork of forks) {
          const page = yield* api.ReadPath({
            chatId: chats[0]!.id,
            forkId: fork.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          for (const e of page.entries) {
            ids.set(e.version.content, e.version.speakerEntityId!)
            if (e.version.content === "One speaks.") {
              const versions = yield* api.ListVersions({ slotId: e.slotId, forkId: fork.id })
              assert.strictEqual(versions.length, 50)
              assert.strictEqual(
                versions.findIndex((v) => v.id === e.version.id),
                31
              )
              assert.strictEqual(e.version.reasoning, "Synthetic private reasoning.")
            }
          }
        }
        assert.isString(ids.get("One speaks."))
        assert.isString(ids.get("Two speaks."))
        assert.notStrictEqual(ids.get("One speaks."), ids.get("Two speaks."))
        assert.strictEqual(ids.get("Two speaks."), ids.get("Alternate second."))
        assert.deepStrictEqual([...ids.keys()].sort(), [...speakerTexts.keys()].sort())
      })
    )
  }
)

layer(serverLayer(testConfig({ authMode: "proxy" })), { excludeTestServices: true, timeout: "120 seconds" })(
  "export ownership and native downloads",
  (it) => {
    it.effect("refuses guessed ids and tickets, locks preparation, and releases Stop before start", () =>
      Effect.gen(function* () {
        const port = yield* serverPort
        const users = []
        for (const handle of ["alice", "bob"]) {
          const headers = { "remote-user": handle }
          const api = yield* client(headers)
          const chat = yield* api.CreateChat({ title: `${handle}-private-chat` })
          yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: `${handle}-private-text`
          })
          yield* api.CreateCredential({
            name: `${handle}-private-credential`,
            apiKey: `synthetic-secret-${handle}`,
            urls: ["https://synthetic.invalid/v1"]
          })
          yield* api.CreateConnection({
            kind: "openai-chat",
            settings: {
              name: `${handle}-private-connection`,
              baseUrl: "https://synthetic.invalid/v1",
              compat: {},
              cacheTtlS: null,
              maxConcurrent: null,
              presetOverrideRefId: null
            },
            apiKey: `synthetic-connection-key-${handle}`
          })
          users.push({ headers, api, chat })
        }
        const get = (path: string, headers: Record<string, string>) =>
          Effect.promise(() => fetch(`http://127.0.0.1:${port}${path}`, { headers }))
        for (const [owner, other] of [
          [users[0]!, users[1]!],
          [users[1]!, users[0]!]
        ] as const) {
          const input = { chatId: owner.chat.id, forkId: null, scope: "branch", format: "jsonl" }
          assert.strictEqual((yield* post("/library/chat-export", input, other.headers)).status, 404)
          assert.strictEqual(
            (yield* post(
              "/library/chat-export",
              { ...input, chatId: other.chat.id, forkId: owner.chat.currentForkId },
              other.headers
            )).status,
            404
          )
          const native = { ...owner.headers, "x-export-download": "native" }
          const responses = yield* Effect.all(
            [post("/library/chat-export", input, native), post("/library/archive", {}, native)],
            { concurrency: "unbounded" }
          )
          assert.deepStrictEqual(responses.map((r) => r.status).sort(), [200, 503])
          const prepared = responses.find((r) => r.status === 200)!
          const { key } = yield* Effect.promise(async () => (await prepared.json()) as { key: string })
          for (const route of ["download", "download-status"]) {
            assert.strictEqual((yield* get(`/library/${route}?key=${key}`, other.headers)).status, 404)
            assert.strictEqual((yield* get(`/library/${route}?key=${key}`, {})).status, 401)
          }
          assert.strictEqual((yield* post(`/library/download-stop?key=${key}`, {}, other.headers)).status, 404)
          assert.strictEqual((yield* post(`/library/download-stop?key=${key}`, {}, owner.headers)).status, 200)
          assert.strictEqual((yield* get(`/library/download?key=${key}`, owner.headers)).status, 404)
          // Another account can export simultaneously; its archive never contains the owner's files.
          const whole = yield* post("/library/archive", {}, other.headers)
          assert.strictEqual(whole.status, 200)
          const bytes = new Uint8Array(yield* Effect.promise(() => whole.arrayBuffer()))
          const files = readZip(bytes, defaultLimits)
          const budget = { used: 0 }
          let contents = ""
          for (const [name, entry] of files)
            contents += name + new TextDecoder().decode(extract(bytes, entry, defaultLimits, budget))
          const otherName = other.headers["remote-user"]
          const ownerName = owner.headers["remote-user"]
          assert.include(contents, `${otherName}-private-text`)
          assert.notInclude(contents, `${ownerName}-private-text`)
          assert.notInclude(contents, `${ownerName}-private-chat`)
          for (const forbidden of [
            "synthetic-secret-",
            "synthetic-connection-key-",
            "synthetic.invalid",
            "private-credential",
            "private-connection"
          ])
            assert.notInclude(contents, forbidden)
          const retry = yield* post("/library/chat-export", input, native)
          assert.strictEqual(retry.status, 200)
          const retryKey = (yield* Effect.promise(async () => (await retry.json()) as { key: string })).key
          const download = yield* get(`/library/download?key=${retryKey}`, owner.headers)
          assert.strictEqual(download.status, 200)
          assert.include(yield* Effect.promise(() => download.text()), `${ownerName}-private-text`)
          const status = yield* get(`/library/download-status?key=${retryKey}`, owner.headers)
          assert.deepInclude(yield* Effect.promise(() => status.json()), { done: true, error: null })
          assert.strictEqual((yield* get(`/library/download?key=${retryKey}`, owner.headers)).status, 404)
        }
      })
    )
  }
)

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "120 seconds" })(
  "empty-cast archive round trip",
  (it) => {
    it.effect("imports the transcript without inventing a character card", () =>
      Effect.gen(function* () {
        assert.strictEqual(emptyArchive.size, 3)
        const { api, report } = yield* importStFolder(emptyArchive)
        assert.deepStrictEqual(report.issues, [])
        assert.strictEqual((yield* api.ListLibrary({ kind: "card" })).length, 0)
        const chats = yield* api.ListChats({ limit: 10, before: null })
        assert.strictEqual(chats.length, 1)
        assert.strictEqual(chats[0]!.title, "No cast")
        const path = yield* api.ReadPath({
          chatId: chats[0]!.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 10
        })
        assert.strictEqual(path.entries.length, 1)
        assert.strictEqual(path.entries[0]!.version.content, "A transcript with no characters.")
      })
    )
  }
)
