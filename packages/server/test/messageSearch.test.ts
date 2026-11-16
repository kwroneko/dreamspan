// SearchMessages (db/messageSearch.ts): a hit is a message version with the branches that show
// it, never one per branch; unselected swipes, deleted messages and deleted chats aren't hits;
// a branch's own replaced text is its own hit; pages go on from their cursor.
import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { MessageSearchPage } from "@rp/shared/messageSearch.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

const said = (content: string, writer: "human" | "model" = "human") =>
  new NewVersion({
    speakerEntityId: null,
    writer,
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: writer === "human" ? "user_written" : "generated"
  })

const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id
  const writer = yield* Writer
  const reader = yield* Reader
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "The harbour",
    participants: [],
    greeting: null
  })
  const chatId = chat.id
  const main = chat.currentForkId!
  const append = (parentSlotId: SlotId | null, content: string, forkId = main) =>
    writer.AppendMessage({
      userId,
      chatId,
      forkId,
      parentSlotId,
      branch: false,
      version: said(content),
      commitDraft: null
    })
  const first = yield* append(null, "The lighthouse keeper waves from the pier.")
  const second = yield* append(first.slotId, "A gull lands on the café roof.")
  const branch = (yield* writer.CreateFork({ userId, chatId, fromForkId: main, atSlotId: second.slotId })).fork.id
  const mainOnly = yield* append(second.slotId, "Only the main line sees the lantern.")
  const branchOnly = yield* append(second.slotId, "Only the branch sees the lantern.", branch)
  const search = (text: string, cursor: { before: number } | null = null) => api.SearchMessages({ text, cursor })
  return { api, userId, writer, reader, chatId, main, branch, first, second, mainOnly, branchOnly, search }
})

describe("message search", () => {
  it.effect("treats punctuation as separators, operators as words and Unicode as text", () =>
    Effect.gen(function* () {
      const f = yield* setup
      yield* f.writer.AppendMessage({
        userId: f.userId,
        chatId: f.chatId,
        forkId: f.main,
        parentSlotId: f.mainOnly.slotId,
        branch: false,
        version: said("École 東京の灯台 café AND OR NEAR 🌊"),
        commitDraft: null
      })
      for (const query of [
        '"École"',
        "e\u0301cole",
        // Quotes make a phrase of whole words; the index keeps 東京の灯台 as one word, so 東京 is its start.
        "東京*",
        '東京 "*"',
        "AND OR NEAR",
        "café + école - 東京",
        "école ".repeat(28).trim()
      ])
        assert.lengthOf((yield* f.search(query)).hits, 1, query)
      for (const query of ["🌊🌊", "***", '""', '"東京"']) assert.lengthOf((yield* f.search(query)).hits, 0, query)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("finds a shared message once, with every branch that shows it", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const page = yield* f.search("lighthouse")
      assert.lengthOf(page.hits, 1)
      const hit = page.hits[0]!
      assert.strictEqual(hit.slotId, f.first.slotId)
      assert.strictEqual(hit.chatName, "The harbour")
      assert.strictEqual(hit.speaker, "You")
      assert.strictEqual(hit.position, 1)
      assert.strictEqual(hit.branchCount, 2)
      assert.sameMembers(
        hit.branches.map((b) => b.forkId),
        [f.main, f.branch]
      )
      // The chat's current branch first: it opens there.
      assert.isTrue(hit.branches[0]!.current)
      assert.deepStrictEqual(hit.excerpt.marks, [{ at: 4, length: 10 }])
      assert.strictEqual(hit.excerpt.text.slice(4, 14), "lighthouse")
      assert.isNull(page.next)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("names only the branches a message is on, newest first, every word at a word's start", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const page = yield* f.search("lantern only")
      assert.deepStrictEqual(
        page.hits.map((h) => [h.slotId, h.branches.map((b) => b.forkId)]),
        [
          [f.branchOnly.slotId, [f.branch]],
          [f.mainOnly.slotId, [f.main]]
        ]
      )
      assert.lengthOf((yield* f.search("lantern xyzzy")).hits, 0)
      // A prefix of a word matches; the middle of one doesn't; accents and case fold.
      assert.lengthOf((yield* f.search("light")).hits, 1)
      assert.lengthOf((yield* f.search("house")).hits, 0)
      assert.lengthOf((yield* f.search("CAFE")).hits, 1)
      assert.strictEqual((yield* f.search("CAFE")).hits[0]!.excerpt.marks[0]!.length, 4)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("leaves out unselected swipes until a branch shows one, and a branch's replaced text is its own hit", () =>
    Effect.gen(function* () {
      const f = yield* setup
      const swipe = yield* f.writer.AddVersion({
        userId: f.userId,
        slotId: f.first.slotId,
        version: said("A swipe about the lighthouse in fog."),
        select: false,
        commitDraft: null
      })
      assert.lengthOf((yield* f.search("fog")).hits, 0)
      yield* f.writer.SelectVersion({
        userId: f.userId,
        slotId: f.first.slotId,
        versionId: swipe.id,
        forkId: f.branch,
        expectedVersionId: f.first.version.id
      })
      const fog = yield* f.search("fog")
      assert.lengthOf(fog.hits, 1)
      assert.deepStrictEqual(
        fog.hits[0]!.branches.map((b) => b.forkId),
        [f.branch]
      )
      // The original is now only the main line's.
      assert.deepStrictEqual(
        (yield* f.search("keeper")).hits[0]!.branches.map((b) => b.forkId),
        [f.main]
      )
      // Search and replace in the main line writes its own copy: a hit of its own, there only.
      const preview = yield* f.api.PreviewHistory({
        chatId: f.chatId,
        forkId: f.main,
        search: {
          pairs: [{ find: "gull", replace: "heron" }],
          matchCase: false,
          wholeWord: true,
          regex: false,
          preserveCase: false,
          messages: true,
          swipes: false,
          summaries: false
        }
      })
      yield* f.api.ApplyHistoryEdits({
        title: "Heron",
        applications: [
          {
            chatId: f.chatId,
            forkId: f.main,
            edits: preview.hits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
      assert.deepStrictEqual(
        (yield* f.search("heron")).hits.map((h) => h.branches.map((b) => b.forkId)),
        [[f.main]]
      )
      assert.deepStrictEqual(
        (yield* f.search("gull")).hits.map((h) => h.branches.map((b) => b.forkId)),
        [[f.branch]]
      )
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("leaves out deleted messages and chats", () =>
    Effect.gen(function* () {
      const f = yield* setup
      yield* f.writer.DeleteMessage({ userId: f.userId, slotId: f.mainOnly.slotId, forkId: f.main })
      assert.deepStrictEqual(
        (yield* f.search("lantern")).hits.map((h) => h.slotId),
        [f.branchOnly.slotId]
      )
      yield* f.writer.DeleteChat({ userId: f.userId, chatId: f.chatId })
      assert.lengthOf((yield* f.search("lantern")).hits, 0)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("pages on from the cursor without repeating or skipping a hit", () =>
    Effect.gen(function* () {
      const f = yield* setup
      let parent = f.mainOnly.slotId
      for (let i = 0; i < 45; i++)
        parent = (yield* f.writer.AppendMessage({
          userId: f.userId,
          chatId: f.chatId,
          forkId: f.main,
          parentSlotId: parent,
          branch: false,
          version: said(`Tide number ${i}.`),
          commitDraft: null
        })).slotId
      const seen: Array<string> = []
      let cursor: { before: number } | null = null
      let pages = 0
      do {
        const page: MessageSearchPage = yield* f.search("tide", cursor)
        seen.push(...page.hits.map((h) => h.excerpt.text))
        cursor = page.next
        pages++
      } while (cursor !== null && pages < 10)
      assert.strictEqual(pages, 3)
      assert.lengthOf(new Set(seen), 45)
      assert.strictEqual(seen[0], "Tide number 44.")
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )

  it.effect("ranks words side by side above the same words apart, and quotes find only the phrase", () =>
    Effect.gen(function* () {
      const f = yield* setup
      let parent = f.mainOnly.slotId
      const add = (content: string) =>
        Effect.map(
          f.writer.AppendMessage({
            userId: f.userId,
            chatId: f.chatId,
            forkId: f.main,
            parentSlotId: parent,
            branch: false,
            version: said(content),
            commitDraft: null
          }),
          (slot) => {
            parent = slot.slotId
            return slot.slotId
          }
        )
      // Oldest first: the phrase, then newer messages with the words apart.
      const phrase = yield* add(
        `${"Rain on the glass. ".repeat(12)}The note on the desk: her handwriting was unmistakable, even now.`
      )
      const prefix = yield* add("Their handwritings were unmistakably hers.")
      const apart = yield* add("The handwriting was smudged, but the seal was unmistakable.")
      const newest = yield* add("Unmistakable, he said: it was the handwriting of a stranger.")
      const slots = (page: MessageSearchPage) => page.hits.map((h) => h.slotId)

      const ranked = yield* f.search("handwriting was unmistakable")
      assert.deepStrictEqual(slots(ranked), [phrase, newest, apart])
      // The excerpt is centred on the phrase, every word of it marked.
      const shown = ranked.hits[0]!.excerpt
      const marked = shown.marks.map((m) => shown.text.slice(m.at, m.at + m.length))
      assert.includeMembers(marked, ["handwriting", "was", "unmistakable"])
      assert.include(shown.text, "her handwriting was unmistakable")
      // Each word is still the start of a word; with no message having them side by side, newest first.
      assert.deepStrictEqual(slots(yield* f.search("handwriting unmistakabl")), [newest, apart, prefix, phrase])

      assert.deepStrictEqual(slots(yield* f.search('"handwriting was unmistakable"')), [phrase])
      assert.deepStrictEqual(slots(yield* f.search("“Handwriting, was unmistakable”")), [phrase])
      // Quoted words are whole words, and other words beside a phrase are required too.
      assert.deepStrictEqual(slots(yield* f.search('"handwriting was unmistak"')), [])
      assert.deepStrictEqual(slots(yield* f.search('"the seal" smudged')), [apart])

      // Pages go on from the side-by-side matches into the rest without repeats.
      const seen: Array<string> = []
      let cursor: MessageSearchPage["next"] = null
      for (let page = 0; page < 6; page++) {
        const read: MessageSearchPage = yield* f.reader.SearchMessages({
          userId: f.userId,
          text: "handwriting was unmistakable",
          cursor,
          limit: 1
        })
        seen.push(...read.hits.map((h) => h.slotId))
        cursor = read.next
        if (cursor === null) break
      }
      assert.deepStrictEqual(seen, [phrase, newest, apart])
      assert.isNull(cursor)
    }).pipe(Effect.provide(serverLayer(testConfig())))
  )
})
