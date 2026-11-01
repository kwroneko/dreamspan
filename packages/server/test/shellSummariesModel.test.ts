// Per-fork summary validity (db/summaryValidity.ts) against random writes: a chat with several
// forks sharing prefixes takes seeded sequences of the writes the shell's walk reads (appends,
// branches, swipes, selections, edits, deletes and restores in a fork or for all of them,
// purges, insertions, hides, state events in one fork or for the chat, fork deletion and
// restore). After each write a read serves what was stored where it can, and it must equal one
// computed from scratch: a summary a write made wrong but left valid fails it. Writes that a
// step's random choice makes invalid fail and roll back, which must leave every summary right
// too. `npm test` runs one seed; `npm run test:slow` runs more (SHELL_MODEL_SEEDS, _STEPS, _SEED;
// SHELL_MODEL_STATS names a file for each seed's tally of writes).
import { appendFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { type EntityId, type ForkId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import { Effect, Exit } from "effect"
import * as Database from "../src/db/Database.ts"
import type { ShellLibraryRead } from "../src/db/ops.ts"
import { cardDoc } from "./support/docs.ts"
import { slowIt } from "./support/slow.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const database = () =>
  Database.layer({ dataDir: tempDir("shellmodel"), readers: 2, allowNetworkFs: false, ...testWorkers })

type Read = typeof ShellLibraryRead.Type
const library = ({ fresh: _, ...rest }: Read) => rest

/** mulberry32: a small seeded generator, so a failing seed replays. */
const generator = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const kinds = [
  "append",
  "append",
  "append",
  "branch",
  "fork",
  "fork",
  "swipe",
  "select",
  "amend",
  "delete",
  "delete",
  "deleteVersion",
  "restore",
  "purge",
  "purge",
  "insert",
  "hide",
  "event",
  "event",
  "chatEvent",
  "swap",
  "switch",
  "deleteFork"
] as const

const run = (seed: number, steps: number) =>
  Effect.gen(function* () {
    const random = generator(seed)
    const pick = <T>(items: ReadonlyArray<T>): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(random() * items.length)]
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const { id: userId } = yield* writer.EnsureUser({ handle: "ana", displayName: "ana" })
    const makeCard = (name: string) =>
      writer.CreateEntity({
        userId,
        kind: "card",
        label: name,
        subtitle: "",
        doc: cardDoc(name),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const cards = [yield* makeCard("Mira"), yield* makeCard("Tam"), yield* makeCard("Ode")]
    const ids = cards.map((c) => c.entityId as EntityId)
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [ids[0]!, ids[1]!],
      greeting: null
    })
    // A second chat, which no write here may make wrong either.
    const other = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Other",
      participants: [ids[2]!],
      greeting: null
    })
    const version = (content: string, speaker: EntityId | null) =>
      new NewVersion({
        speakerEntityId: speaker,
        writer: speaker === null ? "human" : "model",
        content,
        status: "complete",
        macroMode: "verbatim",
        origin: speaker === null ? "user_written" : "generated"
      })
    const speaker = () => (random() < 0.3 ? null : pick(ids)!)
    const versions = new Map<SlotId, Array<VersionId>>()
    const bin: Array<string> = []
    const forkBin: Array<string> = []
    let n = 0
    const text = () => `m${n++} ${random().toString(36).slice(2, 8)}`

    const forks = () => reader.ListForks({ userId, chatId: chat.id })
    const anyFork = (): Effect.Effect<ForkId | null> =>
      Effect.map(Effect.orDie(forks()), (list) => (random() < 0.15 ? null : (pick(list)?.id ?? null)))
    /** A slot on a fork's path, or any slot known: some writes off a fork's path are refused. */
    const slotIn = (forkId: ForkId | null) =>
      Effect.gen(function* () {
        if (forkId !== null && random() < 0.85) {
          const path = yield* Effect.orDie(
            reader.GetPath({ userId, chatId: chat.id, forkId, leafSlotId: null, limit: 200 })
          )
          // Often early on the path, where other forks share it.
          const shared = path.entries.slice(0, Math.ceil(path.entries.length / 2))
          const entry = pick(random() < 0.5 ? shared : path.entries)
          if (entry) return entry.slotId
        }
        return pick([...versions.keys()]) ?? null
      })

    const step = (kind: (typeof kinds)[number]) =>
      Effect.gen(function* () {
        const forkId = yield* anyFork()
        switch (kind) {
          case "append":
          case "branch": {
            const list = yield* Effect.orDie(forks())
            const fork = forkId === null ? undefined : list.find((f) => f.id === forkId)
            const parent = kind === "append" ? (fork?.tipSlotId ?? null) : yield* slotIn(forkId)
            const made = yield* writer.AppendMessage({
              userId,
              chatId: chat.id,
              ...(forkId ? { forkId } : {}),
              parentSlotId: parent,
              branch: kind === "branch",
              version: version(text(), speaker()),
              commitDraft: null
            })
            versions.set(made.slotId, [made.version.id])
            if (random() < 0.2)
              yield* writer.AppendMessage({
                userId,
                chatId: other.id,
                parentSlotId: null,
                branch: true,
                version: version(text(), ids[2]!),
                commitDraft: null
              })
            return
          }
          case "fork": {
            const at = yield* slotIn(forkId)
            yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: forkId, atSlotId: at })
            return
          }
          case "swipe": {
            const slotId = yield* slotIn(forkId)
            if (slotId === null) return
            const made = yield* writer.AddVersion({
              userId,
              slotId,
              ...(forkId ? { forkId } : {}),
              version: version(text(), speaker()),
              select: random() < 0.7,
              commitDraft: null
            })
            versions.get(slotId)?.push(made.id)
            return
          }
          case "select": {
            const slotId = yield* slotIn(forkId)
            if (slotId === null) return
            const shown = yield* reader.GetSlot({ userId, slotId, forkId })
            const versionId = pick(versions.get(slotId) ?? [])
            if (versionId === undefined) return
            yield* writer.SelectVersion({
              userId,
              slotId,
              ...(forkId ? { forkId } : {}),
              versionId,
              expectedVersionId: shown.entry.version.id
            })
            return
          }
          case "amend": {
            const slotId = yield* slotIn(forkId)
            if (slotId === null) return
            const shown = yield* reader.GetSlot({ userId, slotId, forkId })
            yield* writer.AmendVersion({
              userId,
              versionId: shown.entry.version.id,
              ...(forkId ? { forkId } : {}),
              content: text(),
              expectedRowVersion: shown.entry.version.rowVersion
            })
            return
          }
          case "delete": {
            const slotId = yield* slotIn(forkId)
            if (slotId === null) return
            bin.push((yield* writer.DeleteMessage({ userId, slotId, ...(forkId ? { forkId } : {}) })).id)
            return
          }
          case "deleteVersion": {
            const slotId = yield* slotIn(forkId)
            const versionId = slotId === null ? undefined : pick(versions.get(slotId) ?? [])
            if (versionId === undefined) return
            bin.push((yield* writer.DeleteVersion({ userId, versionId, ...(forkId ? { forkId } : {}) })).id)
            return
          }
          case "restore": {
            const itemId = random() < 0.5 ? pick(forkBin) : pick(bin)
            if (itemId === undefined) return
            yield* writer.RestoreBinItem({ userId, itemId })
            return
          }
          case "purge": {
            const itemId = random() < 0.3 ? pick(forkBin) : pick(bin)
            if (itemId === undefined) return
            yield* writer.PurgeBinItem({ userId, itemId })
            return
          }
          case "insert": {
            // A chat with an insertion makes every slot write reach all its forks, which would
            // leave the finer rules untried: only odd seeds insert.
            if (forkId === null || seed % 2 === 0) return
            const anchor = yield* slotIn(forkId)
            const rowVersion =
              anchor === null ? 0 : (yield* reader.GetSlot({ userId, slotId: anchor, forkId })).entry.rowVersion
            yield* writer.InsertMessage({
              userId,
              chatId: chat.id,
              forkId,
              anchorSlotId: anchor,
              expectedRowVersion: rowVersion,
              body: { _tag: "Write", speaker: pick(ids)!, content: text() }
            })
            return
          }
          case "hide": {
            const slotId = yield* slotIn(forkId)
            if (slotId === null) return
            yield* writer.SetSlotHidden({ userId, slotId, ...(forkId ? { forkId } : {}), hidden: random() < 0.7 })
            return
          }
          case "event":
          case "chatEvent": {
            const slotId = random() < 0.2 ? null : yield* slotIn(forkId)
            const entity = pick(ids)!
            const data =
              random() < 0.4
                ? ({ key: "participant.leave", value: { entity } } as const)
                : random() < 0.5
                  ? ({ key: "participant.join", value: { entity } } as const)
                  : random() < 0.5
                    ? ({ key: "presence.set", value: { entity, present: random() < 0.5 } } as const)
                    : ({ key: "played_by_me.set", value: { entities: [entity] } } as const)
            yield* writer.AddStateEvent({
              userId,
              chatId: chat.id,
              ...(kind === "event" ? { forkId } : { forkId: null }),
              slotId,
              versionId: null,
              scope: null,
              data
            })
            return
          }
          case "swap": {
            const slotId = yield* slotIn(forkId)
            const [entity, replaces] = [pick(ids)!, pick(ids)!]
            yield* writer.AddStateEvent({
              userId,
              chatId: chat.id,
              forkId,
              slotId,
              versionId: null,
              scope: null,
              data: { key: "card.swap", value: { entity, replaces } }
            })
            return
          }
          case "switch": {
            const slotId = yield* slotIn(forkId)
            if (slotId === null) return
            yield* writer.SwitchBranch({ userId, chatId: chat.id, slotId, index: Math.floor(random() * 3), forkId })
            return
          }
          case "deleteFork": {
            if (forkId === null) return
            forkBin.push((yield* writer.DeleteFork({ userId, forkId })).id)
            return
          }
        }
      })

    /** A read serves what was stored where it can; it must equal one from scratch. Then it's stored. */
    const check = (label: string) =>
      Effect.gen(function* () {
        const first = yield* reader.ShellLibrary({ userId })
        const scratch = yield* reader.ShellLibrary({ userId, recompute: true })
        assert.deepStrictEqual(library(first), library(scratch), label)
        if (random() < 0.85) yield* writer.StoreForkSummaries({ userId, chats: first.fresh })
      })

    yield* check(`seed ${seed}: start`)
    const done: Array<string> = []
    for (let i = 0; i < steps; i++) {
      const kind = pick(kinds)!
      const exit = yield* Effect.exit(step(kind))
      done.push(`${kind}${Exit.isSuccess(exit) ? "" : "!"}`)
      // Reads now and then let several writes go by before one.
      if (random() < 0.8) yield* check(`seed ${seed}, step ${i}: ${done.slice(-6).join(" ")}`)
    }
    yield* check(`seed ${seed}: end`)
    // SHELL_MODEL_STATS=<file>: which writes ran, and which were refused (!), per seed.
    const stats = process.env.SHELL_MODEL_STATS
    if (stats !== undefined) {
      const counts = new Map<string, number>()
      for (const d of done) counts.set(d, (counts.get(d) ?? 0) + 1)
      const line = [...counts].sort().map(([k, v]) => `${k}=${v}`)
      appendFileSync(stats, `${seed} ${line.join(" ")}\n`)
    }
    return done
  }).pipe(Effect.provide(database()))

const SEEDS = Number(process.env.SHELL_MODEL_SEEDS ?? 6)
const STEPS = Number(process.env.SHELL_MODEL_STEPS ?? 120)
const ONLY = process.env.SHELL_MODEL_SEED

describe("shell summaries under random writes", () => {
  it.live(
    "a read from stored summaries equals one from scratch after every write (one seed)",
    () =>
      Effect.gen(function* () {
        const done = yield* run(2, 80)
        // The run exercised writes that succeeded, not only refusals.
        assert.isAbove(done.filter((d) => !d.endsWith("!")).length, 40)
      }),
    120_000
  )

  slowIt.live(
    "a read from stored summaries equals one from scratch after every write (many seeds)",
    () =>
      Effect.gen(function* () {
        const seeds = ONLY !== undefined ? [Number(ONLY)] : Array.from({ length: SEEDS }, (_, i) => 100 + i)
        for (const seed of seeds) yield* run(seed, STEPS)
      }),
    600_000
  )
})
