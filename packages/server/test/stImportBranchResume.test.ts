// An ST import cancelled midway through a chat's "Branch #N" files, one of them cut off after
// its first part, then run again from the start (ARCHITECTURE.md §13): the chat ends with the
// forks and summaries a single uninterrupted import gives, and every summary the shell keeps
// equals one computed from scratch (db/summaryValidity.ts keeps the untouched ones valid).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { sendFile, sendStFile } from "./support/stUpload.ts"

const BRANCHES = 8
const PREFIX = 30
const CUT = 5

/** The main chat, then branches of it or of the branch before, as the scale test makes them. */
const files = () => {
  const said = (n: number, text: string) =>
    message({ name: n % 2 ? "Sam" : "Alice", user: n % 2 === 1, mes: text, minute: n })
  const chats = [
    {
      name: "Alice - 2025-12-01@10h00m00s",
      lines: Array.from({ length: PREFIX }, (_, n) => said(n, `Main ${n}.`)),
      parent: ""
    }
  ]
  for (let k = 1; k <= BRANCHES; k++) {
    const parent = k % 3 === 1 ? chats[0]! : chats.at(-1)!
    const point = Math.min(parent.lines.length, PREFIX - 10 + ((k * 7) % 10))
    const own = Array.from({ length: 4 }, (_, i) => said(point + i, `Branch ${k} message ${i}.`))
    const name = `Branch #${point - 1} - 2025-12-27@12h00m${String(k).padStart(2, "0")}s`
    chats.push({ name, lines: [...parent.lines.slice(0, point), ...own], parent: parent.name })
  }
  return chats.map((c) => ({
    path: `chats/Alice/${c.name}.jsonl`,
    lines: [header(c.parent === "" ? {} : { main_chat: c.parent }), ...c.lines]
  }))
}

/** What the shell shows of the user's forks, without ids. */
const shown = (userId: string, recompute: boolean) =>
  Effect.gen(function* () {
    const library = yield* (yield* Reader).ShellLibrary({ userId: userId as never, recompute })
    if (!recompute) yield* (yield* Writer).StoreForkSummaries({ userId: userId as never, chats: library.fresh })
    return library.forks
      .map((f) => ({
        name: f.name,
        preview: f.preview,
        messages: f.messages,
        branches: f.branches,
        cast: f.cast.length,
        joined: f.joined.length,
        activity: f.activity.map((a) => [a.at, a.category])
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.preview.localeCompare(b.preview))
  })

const importAll = (cutAt: number | null) =>
  Effect.gen(function* () {
    const api = yield* client()
    const userId = (yield* api.Whoami()).id
    const chats = files()
    const start = Effect.gen(function* () {
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      yield* sendStFile(importId, "characters/Alice.png", card("Alice", "Hello."))
      return importId
    })
    if (cutAt !== null) {
      const first = yield* start
      for (const chat of chats.slice(0, cutAt)) yield* sendStFile(first, chat.path, jsonl(chat.lines))
      // The next branch's first part only, then the cancel.
      const cut = chats[cutAt]!
      const half = Math.floor(cut.lines.length / 2)
      const head = new TextEncoder().encode(
        cut.lines
          .slice(0, half)
          .map((line) => JSON.stringify(line) + "\n")
          .join("")
      )
      const part = yield* sendFile(first, cut.path, head, { part: "0", last: "0" })
      assert.strictEqual(part.status, 200)
      yield* api.CancelStImport({ importId: first })
      // The cut branch is in the chat already, as far as its first part went.
      const partial = yield* shown(userId, true)
      assert.lengthOf(partial, cutAt + 1)
      assert.isTrue(
        partial.some((f) => f.messages === half - 1),
        "half the cut branch, less its header"
      )
    }
    const again = yield* start
    for (const chat of chats) {
      const answer = yield* sendStFile(again, chat.path, jsonl(chat.lines))
      assert.notInclude(["failed", "deferred"], answer.outcome, chat.path)
    }
    yield* api.FinishStImport({ importId: again, notSent: [] })
    const stored = yield* shown(userId, false)
    // Stored, then read back from storage: the same as from scratch.
    assert.deepStrictEqual(yield* shown(userId, false), stored)
    assert.deepStrictEqual(yield* shown(userId, true), stored)
    return stored
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))

describe("ST branch files, cancelled and run again", () => {
  it.live(
    "end as an uninterrupted import does",
    () =>
      Effect.gen(function* () {
        const clean = yield* importAll(null)
        assert.lengthOf(clean, BRANCHES + 1)
        const resumed = yield* importAll(CUT)
        assert.deepStrictEqual(resumed, clean)
      }),
    120_000
  )
})
