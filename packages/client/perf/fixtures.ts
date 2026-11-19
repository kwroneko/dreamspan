// Synthetic chats for the performance harness (CLIENT-FRAMEWORK §7): one of 100,000
// messages and two of 300, generated, never derived from real chats (CLAUDE.md "Privacy").
//
// The schema comes from the server itself (it migrates a fresh data directory and creates
// the chats through RPC); the messages are then written straight into the file in one
// transaction, which takes seconds where 100,000 RPCs would take minutes. The result is
// cached by fixture version and copied for each run.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { startServer, withClient } from "./support.ts"

/** Bump when what's generated changes, so a stale cache isn't used. */
const VERSION = 6
/** A bounded full-length scroll review; the normal harness remains 100,000 messages. */
const longCount = process.env.PERF_LONG_MESSAGES === "6000" ? 6000 : 100_000
const DB = "rp-harness.db"

export interface Fixture {
  readonly shape: ReadonlyArray<{ chatId: string; slots: number; branches: number; versions: number }>
  readonly long: { readonly chatId: ChatId; readonly deep: SlotId }
  /** 20,000 messages, the first 18,000 under summaries up to level 4; the divider is at `boundary`. */
  readonly summarized: { readonly chatId: ChatId; readonly boundary: SlotId; readonly covered: SlotId }
  readonly short: ReadonlyArray<{ readonly chatId: ChatId; readonly title: string }>
}

const build = async (dir: string): Promise<Fixture> => {
  const server = await startServer(dir)
  const [long, a, b, summarized] = await withClient(server, (api) =>
    Effect.gen(function* () {
      // No spending ahead: the summarized chat has more raw messages than its window, and on
      // start the summarizer would plan them all, holding the writer for half a minute and
      // failing for want of a model, which is not what these scenarios measure.
      yield* api.SetGenerationDefaults({ defaults: { model: null, preset: null, lcm: { spendAhead: false } } })
      return yield* Effect.all([
        api.CreateChat({ title: "The long voyage" }),
        api.CreateChat({ title: "Harbor watch" }),
        api.CreateChat({ title: "Tide caves" }),
        api.CreateChat({ title: "The summarized voyage" })
      ])
    })
  )
  await server.stop()

  const { longSlots, voyage, shape } = await new Promise<{
    longSlots: Array<SlotId>
    voyage: { slots: Array<SlotId> }
    shape: Fixture["shape"]
  }>((resolve, reject) => {
    const worker = new Worker(new URL("./fixtureWorker.ts", import.meta.url), {
      workerData: { file: join(dir, DB), chats: [long.id, a.id, b.id, summarized.id], longCount }
    })
    let result: Parameters<typeof resolve>[0] | undefined
    worker.once("message", (value: typeof result) => {
      result = value
    })
    worker.once("error", reject)
    worker.once("exit", (code) =>
      code === 0 && result ? resolve(result) : reject(new Error(`fixture worker exited ${code}`))
    )
  })
  return {
    shape,
    long: { chatId: long.id, deep: longSlots[Math.min(30_000, longCount - 1)]! as SlotId },
    summarized: {
      chatId: summarized.id,
      boundary: voyage.slots[18_000]! as SlotId,
      covered: voyage.slots[17_999]! as SlotId
    },
    short: [
      { chatId: a.id, title: a.title },
      { chatId: b.id, title: b.title }
    ]
  }
}

/** A fresh data directory holding the fixtures, built once per fixture version. The caller removes it. */
export const prepare = async (): Promise<{ dataDir: string; fixture: Fixture }> => {
  // Outside the run's own temp directory (globalSetup.ts), so it outlives the run.
  const cache = join(process.env.RP_PERF_CACHE_ROOT ?? tmpdir(), `rp-perf-fixture-v${VERSION}-${longCount}`)
  if (!existsSync(join(cache, "fixture.json"))) {
    const building = mkdtempSync(join(tmpdir(), "rp-perf-build-"))
    try {
      const fixture = await build(building)
      writeFileSync(join(building, "fixture.json"), JSON.stringify(fixture))
      rmSync(cache, { recursive: true, force: true })
      mkdirSync(cache, { recursive: true })
      for (const file of [DB, "fixture.json"]) renameSync(join(building, file), join(cache, file))
    } finally {
      rmSync(building, { recursive: true, force: true })
    }
  }
  const dataDir = mkdtempSync(join(tmpdir(), "rp-perf-"))
  copyFileSync(join(cache, DB), join(dataDir, DB))
  return { dataDir, fixture: JSON.parse(readFileSync(join(cache, "fixture.json"), "utf8")) as Fixture }
}
