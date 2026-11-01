// An ST chat with hundreds of "Branch #N" files (ARCHITECTURE.md §13), which the import merges
// into the one chat as its forks: every file shares a long prefix with its parent and adds a
// few messages of its own. Finishing a file must cost that file, not the chat's forks so far,
// and the shell's reads must stay fast while the import runs and after it. Budget: the last
// 50 files take at most LATE_BUDGET times the first 50, each finish under FILE_CEILING_MS on
// average, and every shell read under READ_CEILING_MS. Measured (48-core host, load 60–80):
// 60–80 ms a file from first to last, reads under 100 ms. Master (before per-fork summary
// validity) at 200 branches: 266 ms a file rising to 1.1 s, reads up to 1.9 s while it ran;
// at 650 it passed the 10-minute limit by file 420, its finishes over 3 s each.
import { writeFileSync } from "node:fs"
import { assert, layer } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { sendStFile } from "./support/stUpload.ts"

const BRANCHES = Number(process.env.ST_BRANCH_SCALE_BRANCHES ?? 650)
const PREFIX = 300
const OWN = 3
const LATE_BUDGET = 3
const FILE_CEILING_MS = 400
const READ_CEILING_MS = 1000

const MAIN = "Alice - 2025-12-01@10h00m00s"
const METADATA = {
  note_prompt: "Keep it gentle.",
  note_position: 1,
  note_depth: 2,
  note_role: 0,
  note_interval: 1,
  variables: { mood: "calm" }
}
type Line = ReturnType<typeof message>

/** The folder's chat files, parents first: the main chat, then each branch of it or of the branch before. */
const files = () => {
  const said = (n: number, text: string): Line =>
    message({ name: n % 2 ? "Sam" : "Alice", user: n % 2 === 1, mes: text, minute: n })
  const main = Array.from({ length: PREFIX }, (_, n) => said(n, `Main message ${n}.`))
  const chats: Array<{ name: string; lines: Array<Line>; parent: string }> = [{ name: MAIN, lines: main, parent: "" }]
  for (let k = 1; k <= BRANCHES; k++) {
    // A chain of branches of branches, restarted from the main chat every fourth.
    const parent = k % 4 === 1 ? chats[0]! : chats.at(-1)!
    const point = Math.min(parent.lines.length, PREFIX - 50 + ((k * 13) % 50))
    const own = Array.from({ length: OWN }, (_, i) => said(point + i, `Branch ${k} message ${i}.`))
    const ms = String(k).padStart(3, "0")
    const name = `Branch #${point - 1} - 2025-12-27@12h${String(Math.floor(k / 60) % 60).padStart(2, "0")}m${String(k % 60).padStart(2, "0")}s${ms}ms`
    chats.push({ name, lines: [...parent.lines.slice(0, point), ...own], parent: parent.name })
  }
  return chats.map((c) => ({
    path: `chats/Alice/${c.name}.jsonl`,
    // ST copies the chat's metadata into a branch: each file brings its author's note and variables.
    bytes: jsonl([header({ ...METADATA, ...(c.parent === "" ? {} : { main_chat: c.parent }) }), ...c.lines])
  }))
}

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "30 minutes" })(
  "ST branch files at scale",
  (it) => {
    it.effect(`${BRANCHES} branch files of one chat import in linear time, with fast shell reads`, () =>
      Effect.gen(function* () {
        const api = yield* client()
        const chats = files()
        const { importId } = yield* api.StartStImport({ unsupported: [] })
        assert.notStrictEqual(
          (yield* sendStFile(importId, "characters/Alice.png", card("Alice", "Hello."))).outcome,
          "failed"
        )
        const view = {
          entity: null,
          chat: null,
          search: "",
          sort: "recent" as const,
          sections: [{ id: "chats" as const, limit: 100 }]
        }
        const timedRead = <A, E, R>(read: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const started = performance.now()
            yield* read
            return performance.now() - started
          })
        const reads = { cards: 0, forks: 0, library: 0, count: 0 }
        const readAll = Effect.gen(function* () {
          reads.cards = Math.max(reads.cards, yield* timedRead(api.GetShellCards()))
          reads.forks = Math.max(reads.forks, yield* timedRead(api.GetShellForks(view)))
          reads.library = Math.max(reads.library, yield* timedRead(api.GetShellLibrary()))
          reads.count++
        })
        // The sidebar's reads while the import runs, as a client polling it would make them.
        const poller = yield* Effect.forkChild(
          Effect.forever(Effect.andThen(Effect.sleep("500 millis"), readAll), { disableYield: true })
        )
        const took: Array<number> = []
        for (const chat of chats) {
          const started = performance.now()
          const answer = yield* sendStFile(importId, chat.path, chat.bytes)
          took.push(performance.now() - started)
          assert.include(["added", "updated"], answer.outcome, chat.path)
        }
        yield* Fiber.interrupt(poller)
        const during = { ...reads }
        reads.cards = reads.forks = reads.library = reads.count = 0
        // The first reads after the import, then once its summaries are stored.
        yield* readAll
        const first = { ...reads }
        yield* Effect.sleep("1 second")
        yield* readAll
        const average = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0) / xs.length
        const early = average(took.slice(1, 51))
        const late = average(took.slice(-50))
        const library = yield* api.GetShellLibrary()
        // Not bounded: a read after a write that reaches every fork of the chat walks them all.
        const userId = (yield* api.Whoami()).id
        const walkAll = yield* timedRead((yield* Reader).ShellLibrary({ userId, recompute: true }))
        const forks = library.forks
        assert.lengthOf(forks, BRANCHES + 1)
        const measured = JSON.stringify({
          branches: BRANCHES,
          totalSeconds: +(took.reduce((a, b) => a + b, 0) / 1000).toFixed(1),
          earlyFileMs: Math.round(early),
          lateFileMs: Math.round(late),
          readsDuring: during,
          readsFirstAfter: first,
          readsAfter: reads,
          walkAllMs: Math.round(walkAll)
        })
        console.log(`ST branch scale: ${measured}`)
        // What the shell shows of each fork, without ids, for comparing builds.
        if (process.env.ST_BRANCH_SCALE_OUT) {
          const names = new Map(library.people.map((p) => [p.entityId as string, p.name]))
          const shown = forks
            .map((f) => ({
              name: f.name,
              preview: f.preview,
              messages: f.messages,
              recentAt: f.recentAt,
              branches: f.branches,
              current: f.current,
              cast: f.cast.map((id) => names.get(id)),
              joined: f.joined.map((id) => names.get(id)),
              departed: f.departed.map((id) => names.get(id)),
              activity: f.activity.map((a) => ({ who: names.get(a.entityId), at: a.at, category: a.category }))
            }))
            .sort((a, b) => a.name.localeCompare(b.name) || a.preview.localeCompare(b.preview))
          writeFileSync(process.env.ST_BRANCH_SCALE_OUT, JSON.stringify({ measured, shown }, null, 1))
        }
        assert.isBelow(late, early * LATE_BUDGET, measured)
        assert.isBelow(late, FILE_CEILING_MS, measured)
        for (const r of [during, first, reads]) {
          assert.isBelow(r.cards, READ_CEILING_MS, measured)
          assert.isBelow(r.forks, READ_CEILING_MS, measured)
          assert.isBelow(r.library, READ_CEILING_MS, measured)
        }
      })
    )
  }
)
