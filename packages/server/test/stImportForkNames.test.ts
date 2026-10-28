// Names the user gave forks in ST (ARCHITECTURE.md §13, spec/CHATS.md): a branch or
// checkpoint file merged into its parent's chat names the branch it makes, where its path
// leaves the parent's. ST's own names give none; a re-import names branches that have no
// name and never replaces one given here.
import { DatabaseSync } from "node:sqlite"
import { Worker } from "node:worker_threads"
import { assert, describe, it, layer } from "@effect/vitest"
import type { SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { stForkName } from "../src/importer/stMapping.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"
import { currentForkSql, selectedInSql } from "../src/db/forkState.ts"

/** The version slot `s` shows in its chat's current fork. */
const SHOWN = selectedInSql(currentForkSql("s.chat_id"), "s")

const config = testConfig()
const jsonl = (...lines: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"))
const message = (mes: string, n: number) => ({
  name: n % 2 ? "User" : "Bot",
  is_user: n % 2 === 1,
  mes,
  send_date: 1_730_000_000_000 + n
})

const query = (sql: string, ...args: Array<string | number>) => {
  const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
  try {
    return db.prepare(sql).all(...args)
  } finally {
    db.close()
  }
}
/** The slot showing `text`: its id and branch name. */
const slotOf = (text: string) =>
  query(
    `SELECT s.id, s.branch_name AS name FROM slots s JOIN versions v ON v.id = ${SHOWN} WHERE v.content = ?`,
    text
  )[0] as { id: SlotId; name: string | null }
/** A statement on the test's database from another connection, off this thread. */
const exec = (statement: string) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(
          `const { workerData, parentPort } = require("node:worker_threads")
           const { DatabaseSync } = require("node:sqlite")
           const db = new DatabaseSync(workerData.file)
           try { db.exec(workerData.statement) } finally { db.close() }
           parentPort.postMessage("done")`,
          { eval: true, workerData: { file: databaseFile(config.dataDir), statement } }
        )
        worker.once("message", () => resolve())
        worker.once("error", reject)
      })
  )

const DATE = "2026-3-14@09h26m53s589ms"

/** One import run of `files` (a parent first), each linked to no card; the run's report. */
const importRun = (files: ReadonlyArray<readonly [string, Uint8Array]>) =>
  Effect.gen(function* () {
    const api = yield* client()
    const { importId } = yield* api.StartStImport({ unsupported: [] })
    for (const [path, bytes] of files) {
      const answer = yield* sendStFile(importId, path, bytes, { card: "none" })
      assert.notInclude(["failed", "deferred"], answer.outcome, path)
    }
    return yield* api.GetStImportReport({ importId })
  })

/** A parent chat in `folder`, and a branch of it called `name` diverging with `own`. */
const parentAndBranch = (folder: string, name: string, own: string | null) => {
  const parent = `Bot - ${DATE}`
  const lines = [message(`${folder} greeting`, 0), message(`${folder} hello`, 1), message(`${folder} main`, 2)]
  return [
    [`chats/${folder}/${parent}.jsonl`, jsonl({ chat_metadata: {} }, ...lines)],
    [
      `chats/${folder}/${name}.jsonl`,
      jsonl(
        { chat_metadata: { main_chat: parent } },
        ...lines.slice(0, 2),
        ...(own === null ? [] : [message(own, 2), message(`${own} reply`, 3)])
      )
    ]
  ] as const
}

describe("stForkName", () => {
  it("gives no name for ST's own names", () => {
    for (const name of [
      `Branch #12 - ${DATE}`,
      "Checkpoint #3 - 2024-07-12@01h31m37s",
      "Bookmark #2 - 2023-6-19@14h20m12s",
      "Bookmark #2 - 2023-6-19 @14h 20m 12s 123ms",
      "   "
    ]) {
      assert.isNull(stForkName(name), name)
    }
    assert.isNull(stForkName(`Bot - ${DATE} - Branch #1`, `Bot - ${DATE}`))
    assert.isNull(stForkName("A renamed chat - Checkpoint #4", "A renamed chat"))
  })
  it("keeps the user's name without ST's date", () => {
    assert.strictEqual(stForkName(`Before the duel - ${DATE}`), "Before the duel")
    assert.strictEqual(stForkName("Before the duel - 2023-6-19@14h20m12s"), "Before the duel")
    assert.strictEqual(stForkName("The duel, won"), "The duel, won")
    assert.strictEqual(stForkName("Branch #2 is better"), "Branch #2 is better")
    assert.strictEqual(stForkName("x".repeat(150)), "x".repeat(100))
  })
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("ST fork names", (it) => {
  it.effect("names the branch a fork file makes, unless ST made the name up", () =>
    Effect.gen(function* () {
      yield* importRun([
        ...parentAndBranch("Auto", `Branch #2 - ${DATE}`, "auto branch"),
        ...parentAndBranch("Check", `Checkpoint #1 - ${DATE}`, "auto checkpoint"),
        ...parentAndBranch("Book", `Bookmark #1 - ${DATE}`, "auto bookmark"),
        ...parentAndBranch("Now", `Bot - ${DATE} - Branch #1`, "auto current"),
        ...parentAndBranch("Named", `Before the duel - ${DATE}`, "named checkpoint"),
        ...parentAndBranch("Renamed", "The duel, won", "renamed file")
      ])
      for (const text of ["auto branch", "auto checkpoint", "auto bookmark", "auto current"]) {
        assert.isNull(slotOf(text).name, text)
      }
      assert.strictEqual(slotOf("named checkpoint").name, "Before the duel")
      assert.strictEqual(slotOf("renamed file").name, "The duel, won")
      // Only where it leaves its parent: not on the messages they share, nor after.
      assert.isNull(slotOf("Named hello").name)
      assert.isNull(slotOf("named checkpoint reply").name)
      assert.isNull(slotOf("Named main").name)
    })
  )

  it.effect("a fork with no message of its own names nothing, and the report doesn't list it", () =>
    Effect.gen(function* () {
      const report = yield* importRun(parentAndBranch("Same", `Nothing new - ${DATE}`, null))
      assert.isFalse(report.issues.some((i) => i.code === "st.fork_same"))
      const named = query(
        "SELECT count(*) AS n FROM slots s JOIN versions v ON v.slot_id = s.id WHERE v.content LIKE 'Same %' AND s.branch_name IS NOT NULL"
      )[0]!.n
      assert.strictEqual(named, 0)
    })
  )

  it.effect("a re-import names a branch that has no name, and never one named here", () =>
    Effect.gen(function* () {
      const files = parentAndBranch("Again", `Into the woods - ${DATE}`, "woods")
      yield* importRun(files)
      const slot = slotOf("woods")
      assert.strictEqual(slot.name, "Into the woods")

      // As imported before branch names were: no name, and a record that never placed one.
      yield* exec(`UPDATE slots SET branch_name = NULL WHERE id = '${slot.id}';
        UPDATE jobs SET payload_json = json_remove(payload_json, '$.named') WHERE kind = 'st-import-chat'`)
      const versionBefore = query("SELECT row_version, st_import_row_version FROM slots WHERE id = ?", slot.id)[0]
      yield* importRun(files)
      assert.strictEqual(slotOf("woods").name, "Into the woods")
      // Naming isn't a local change: the slot still takes ST's selection on a later re-import.
      const versionAfter = query("SELECT row_version, st_import_row_version FROM slots WHERE id = ?", slot.id)[0]!
      assert.strictEqual(versionAfter.row_version, versionAfter.st_import_row_version)
      assert.isAbove(Number(versionAfter.row_version), Number(versionBefore!.row_version))

      // A name given here stays (as SetBranchName gave them before forks: on the slot, the user's).
      const nameHere = (name: string) =>
        exec(`UPDATE slots SET branch_name = nullif('${name}', ''), branch_name_user = 1, row_version = row_version + 1
          WHERE id = '${slot.id}'`)
      yield* nameHere("My own name")
      yield* importRun(files)
      assert.strictEqual(slotOf("woods").name, "My own name")
      // Even from a record that never placed its name.
      yield* exec(`UPDATE jobs SET payload_json = json_remove(payload_json, '$.named') WHERE kind = 'st-import-chat'`)
      yield* importRun(files)
      assert.strictEqual(slotOf("woods").name, "My own name")

      // And a name taken off here stays off.
      yield* nameHere("")
      yield* importRun(files)
      assert.isNull(slotOf("woods").name)
    })
  )
})
