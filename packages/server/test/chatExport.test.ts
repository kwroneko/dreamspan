// "Export this chat" round trip (ARCHITECTURE.md §13b), with synthetic ST data only: a folder
// is imported, its chats exported through the real route, and the exported files imported
// into a second, empty server, which must then hold the same messages, swipes, choices,
// hidden flags, reasoning and recorded generations, branch for branch.
import { assert, layer } from "@effect/vitest"
import type { ChatId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { client, post, serverLayer, testConfig } from "./support/config.ts"
import { stFolder } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"
import { readZip, extract } from "../src/formats/zip.ts"
import { defaultLimits } from "../src/formats/safety.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** A chat as the format holds it: every branch's messages, in a form two servers share. */
const digest = (api: Api, chatId: ChatId) =>
  Effect.gen(function* () {
    const names = new Map<string, string>()
    for (const ref of yield* api.ListLibrary({ kind: "card" })) names.set(ref.entityId, ref.label)
    const branches: Array<string> = []
    for (const fork of yield* api.ListForks({ chatId })) {
      const window = yield* api.ReadPath({
        chatId,
        forkId: fork.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 500
      })
      const messages = []
      for (const entry of window.entries) {
        const versions = yield* api.ListVersions({ slotId: entry.slotId, forkId: fork.id })
        const speaker = entry.version.speakerEntityId ?? entry.firstSpeakerEntityId
        messages.push({
          speaker: speaker === null ? null : (names.get(speaker) ?? "?"),
          writer: entry.version.writer,
          hidden: entry.contextExcluded,
          selected: versions.findIndex((v) => v.id === entry.version.id),
          versions: versions.map((v) => ({
            content: v.content,
            reasoning: v.reasoning ?? null,
            model: v.model,
            recorded: v.recorded ?? null
          }))
        })
      }
      branches.push(JSON.stringify(messages))
    }
    return branches.sort()
  })

const exported = new Map<string, Uint8Array>()
const expected = new Map<string, ReadonlyArray<string>>()
const archive = new Map<string, Uint8Array>()
const library = new Map<string, ReadonlyArray<string>>()

/** The library's entries by kind and name, and its chats' titles. */
const inventory = (api: Api) =>
  Effect.gen(function* () {
    const names: Array<string> = []
    for (const kind of ["card", "lorebook", "preset"] as const)
      for (const ref of yield* api.ListLibrary({ kind })) names.push(`${kind}: ${ref.label}`)
    for (const chat of yield* api.ListChats({ limit: 100, before: null })) names.push(`chat: ${chat.title}`)
    return names.sort()
  })

const bytesOf = (response: Response) =>
  Effect.promise(() => response.arrayBuffer()).pipe(Effect.map((b) => new Uint8Array(b)))

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })("chat export", (it) => {
  it.effect("exports every branch with swipes, hidden messages and reasoning", () =>
    Effect.gen(function* () {
      const { api } = yield* importStFolder(stFolder())
      const chats = yield* api.ListChats({ limit: 100, before: null })
      const alice = chats.find((chat) => chat.title.startsWith("Alice - 2025"))!
      const bob = chats.find((chat) => chat.title === "Bob - long")!
      assert.isDefined(alice, chats.map((c) => c.title).join(", "))
      assert.isDefined(bob)
      expected.set("alice", yield* digest(api, alice.id))
      expected.set("bob", yield* digest(api, bob.id))
      library.set("before", yield* inventory(api))
      for (const chat of chats) library.set(chat.title, yield* digest(api, chat.id))
      const zipped = yield* post("/library/archive", {})
      assert.strictEqual(zipped.status, 200)
      assert.strictEqual(zipped.headers.get("content-type"), "application/zip")
      const whole = yield* bytesOf(zipped)
      const used = { used: 0 }
      for (const [name, entry] of readZip(whole, defaultLimits))
        archive.set(name, extract(whole, entry, defaultLimits, used))
      // The fixture has what the export must carry: two branches, a second swipe chosen,
      // reasoning, and messages hidden from the context.
      type Digested = {
        selected: number
        hidden: boolean
        versions: Array<{ reasoning: string | null }>
      }
      const parse = (branch: string) => JSON.parse(branch) as Array<Digested>
      const aliceBranches = expected.get("alice")!.map(parse)
      assert.strictEqual(aliceBranches.length, 2)
      assert.isTrue(aliceBranches[0]!.some((m) => m.selected === 1 && m.versions.length === 2))
      assert.isTrue(aliceBranches[0]!.some((m) => m.versions.some((v) => v.reasoning !== null)))
      assert.isTrue(parse(expected.get("bob")![0]!).some((m) => m.hidden))

      const all = yield* post("/library/chat-export", { chatId: alice.id, forkId: null, scope: "all", format: "jsonl" })
      assert.strictEqual(all.status, 200)
      assert.strictEqual(all.headers.get("content-type"), "application/zip")
      assert.strictEqual(all.headers.get("x-export-files"), "2")
      assert.strictEqual(all.headers.get("cache-control"), "no-store")
      const zip = yield* bytesOf(all)
      const entries = readZip(zip, defaultLimits)
      const budget = { used: 0 }
      assert.strictEqual(entries.size, 2)
      for (const [name, entry] of entries)
        exported.set(`chats/Alice/${name}`, extract(zip, entry, defaultLimits, budget))
      const branch = [...exported.keys()].find((name) => name.includes(" - Branch #1"))!
      const main = [...exported.keys()].find((name) => name !== branch)!
      const header = JSON.parse(new TextDecoder().decode(exported.get(branch)!).split("\n", 1)[0]!)
      assert.strictEqual(`chats/Alice/${header.chat_metadata.main_chat}.jsonl`, main)

      const single = yield* post("/library/chat-export", {
        chatId: bob.id,
        forkId: null,
        scope: "branch",
        format: "jsonl"
      })
      assert.strictEqual(single.status, 200)
      assert.include(single.headers.get("content-disposition"), 'filename="Bob - long.jsonl"')
      const bobFile = yield* bytesOf(single)
      exported.set("chats/Bob/Bob - long.jsonl", bobFile)
      const bobLines = new TextDecoder()
        .decode(bobFile)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      assert.isTrue(bobLines.slice(1, 16).every((line) => line.is_system === true))

      const text = yield* post("/library/chat-export", { chatId: bob.id, forkId: null, scope: "branch", format: "txt" })
      assert.strictEqual(text.status, 200)
      assert.include(yield* Effect.promise(() => text.text()), "Bob: Old message 0.")

      // Someone else's, or no such chat or branch, is refused before anything is sent.
      const missing = yield* post("/library/chat-export", {
        chatId: "chat_00000000000000000000000000",
        forkId: null,
        scope: "branch",
        format: "jsonl"
      })
      assert.strictEqual(missing.status, 404)
      const badFork = yield* post("/library/chat-export", {
        chatId: bob.id,
        forkId: "fork_00000000000000000000000000",
        scope: "branch",
        format: "jsonl"
      })
      assert.strictEqual(badFork.status, 404)
      assert.strictEqual(
        (yield* post("/library/chat-export", { chatId: bob.id, forkId: null, scope: "all", format: "csv" })).status,
        400
      )
    })
  )
})

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "chat export round trip",
  (it) => {
    it.effect("an exported chat imports into an empty account as the same chat", () =>
      Effect.gen(function* () {
        const source = stFolder()
        const folder = new Map<string, Uint8Array>(
          [...source].filter(
            ([path]) => !path.startsWith("chats/") && !path.startsWith("group chats/") && !path.startsWith("backups/")
          )
        )
        for (const [path, bytes] of exported) folder.set(path, bytes)
        const { api, report } = yield* importStFolder(folder)
        assert.strictEqual(report.counts.chat?.failed ?? 0, 0)
        assert.isFalse(
          report.issues.some((issue) => issue.level === "error"),
          JSON.stringify(report.issues)
        )
        const chats = yield* api.ListChats({ limit: 100, before: null })
        const alice = chats.find((chat) => chat.title.startsWith("Alice - 2025"))!
        const bob = chats.find((chat) => chat.title === "Bob - long")!
        assert.isDefined(alice, chats.map((c) => c.title).join(", "))
        assert.deepStrictEqual(yield* digest(api, alice.id), expected.get("alice"))
        assert.deepStrictEqual(yield* digest(api, bob.id), expected.get("bob"))
      })
    )
  }
)

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "library archive round trip",
  (it) => {
    it.effect("the whole library's archive imports into an empty account as the same library", () =>
      Effect.gen(function* () {
        const { api, report } = yield* importStFolder(archive)
        assert.deepStrictEqual(report.issues, [])
        const after = yield* inventory(api)
        assert.deepStrictEqual(after, library.get("before"))
        for (const chat of yield* api.ListChats({ limit: 100, before: null }))
          assert.deepStrictEqual(yield* digest(api, chat.id), library.get(chat.title), chat.title)
      })
    )
  }
)
