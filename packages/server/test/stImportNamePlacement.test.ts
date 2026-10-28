import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId } from "@rp/shared/chat.ts"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { sendStFile } from "./support/stUpload.ts"

const config = testConfig()

/**
 * A name given in the app on the slot that starts a branch, as SetBranchName gave them before
 * forks (now SetForkName names a fork; ST imports place names on slots until imports map to
 * forks, spec/FORK-INDEPENDENCE-DELTA.md unit 9): marked as the user's, a local change.
 */
const nameHere = ({ slotId, name }: { slotId: SlotId; name: string }) =>
  fixtureSql(config.dataDir, [
    {
      sql: `UPDATE slots SET branch_name = nullif(?, ''), branch_name_user = 1, row_version = row_version + 1 WHERE id = ?`,
      params: [name.trim(), slotId]
    }
  ])
const bytes = (lines: unknown[]) => new TextEncoder().encode(lines.map((x) => JSON.stringify(x)).join("\n"))
const msg = (mes: string, n: number, extra = {}) => ({
  name: n % 2 ? "User" : "Bot",
  is_user: !!(n % 2),
  mes,
  send_date: 1730000000000 + n,
  ...extra
})
const run = (files: [string, Uint8Array][]) =>
  Effect.gen(function* () {
    const api = yield* client()
    const { importId } = yield* api.StartStImport({ unsupported: [] })
    for (const [path, data] of files) {
      const result = yield* sendStFile(importId, path, data, { card: "none" })
      assert.notInclude(["failed", "deferred"], result.outcome)
    }
    return api
  })
const pair = (folder: string, name: string): [string, Uint8Array][] => {
  const common = [msg(folder + " greeting", 0), msg(folder + " hello", 1)]
  return [
    [`chats/${folder}/main.jsonl`, bytes([{ chat_metadata: {} }, ...common, msg(folder + " main", 2)])],
    [
      `chats/${folder}/${name}.jsonl`,
      bytes([{ chat_metadata: { main_chat: "main" } }, ...common, msg(folder + " fork", 2), msg(folder + " reply", 3)])
    ]
  ]
}

type Api = Effect.Success<ReturnType<typeof client>>
const snapshot = (api: Api, source: string) =>
  Effect.gen(function* () {
    const who = yield* api.Whoami()
    const records = (yield* (yield* Reader).StImportSources({ userId: who.id })).chats
    const record = records.find((r) => r.source === source)!
    assert.isDefined(record)
    const path = yield* api.ReadPath({
      chatId: record.chatId,
      leafSlotId: record.end,
      range: { _tag: "Bottom" },
      limit: 100
    })
    const [rows] = yield* fixtureSql(
      config.dataDir,
      [
        {
          sql: "SELECT id,branch_name,branch_name_user FROM slots WHERE chat_id=? ORDER BY depth,id",
          params: [record.chatId]
        }
      ],
      { readOnly: true }
    )
    return { record, entries: path.entries, rows: rows! }
  })
type Snapshot = Effect.Success<ReturnType<typeof snapshot>>
const contents = (entries: Snapshot["entries"]) =>
  entries.map((e) => ({ slot: e.slotId, name: e.branchName, version: e.version }))
layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "automatic fork naming placement",
  (it) => {
    for (const mode of ["writer", "swipe", "rename-writer", "legacy-writer"])
      for (const choice of ["My automatic", ""]) {
        it.effect(`${mode}: local ${JSON.stringify(choice)} follows the current switch point`, () =>
          Effect.gen(function* () {
            const folder = `N3-${mode}-${choice === "" ? 0 : 1}`
            const files = pair(folder, mode === "rename-writer" ? "Named road" : "main - Branch #1")
            let source = files[1]![0]
            const api = yield* run(files)
            const base = yield* snapshot(api, source)
            yield* nameHere({ slotId: base.entries[2]!.slotId, name: choice })
            // Automatic records created before placement bookkeeping have neither field.
            if (mode === "legacy-writer")
              yield* fixtureSql(config.dataDir, [
                {
                  sql: "UPDATE jobs SET payload_json = json_remove(payload_json, '$.named', '$.nameSlot') WHERE id = ?",
                  params: [base.record.recordId]
                }
              ])
            const original = yield* snapshot(api, source)
            const main = yield* snapshot(api, files[0]![0])
            if (mode === "rename-writer") {
              source = `chats/${folder}/main - Branch #1.jsonl`
              yield* run([files[0]!, [source, files[1]![1]]])
              const renamed = yield* snapshot(api, source)
              assert.deepStrictEqual(
                contents(renamed.entries),
                contents(original.entries),
                "identical-byte rename keeps local name and slot IDs"
              )
            }
            const greeting = msg(folder + " greeting", 0)
            const changed =
              mode === "swipe"
                ? {
                    ...greeting,
                    mes: folder + " changed",
                    swipes: [greeting.mes, folder + " changed"],
                    swipe_id: 1,
                    swipe_info: [{ send_date: greeting.send_date }, { send_date: greeting.send_date }]
                  }
                : { ...greeting, is_user: true, name: "User" }
            const bytesChanged = bytes([
              { chat_metadata: { main_chat: "main" } },
              changed,
              msg(folder + " hello", 1),
              msg(folder + " fork", 2),
              msg(folder + " reply", 3)
            ])
            let after: Snapshot | undefined
            let menu: Effect.Success<ReturnType<Api["ListBranches"]>> = []
            for (let pass = 0; pass < 2; pass++) {
              yield* run([files[0]!, [source, bytesChanged]])
              const current = yield* snapshot(api, source)
              const mainAfter = yield* snapshot(api, files[0]![0])
              assert.deepStrictEqual(contents(mainAfter.entries), contents(main.entries), "main path preserved")
              const oldPath = yield* api.ReadPath({
                chatId: original.record.chatId,
                leafSlotId: original.record.end,
                range: { _tag: "Bottom" },
                limit: 100
              })
              assert.deepStrictEqual(contents(oldPath.entries), contents(original.entries), "old child path preserved")
              assert.notStrictEqual(current.entries[0]!.slotId, original.entries[0]!.slotId)
              menu = yield* api.ListBranches({ slotId: current.entries[0]!.slotId })
              if (after) assert.deepStrictEqual(current, after, "unchanged replay keeps path and provenance")
              after = current
            }
            const own = after!.rows.find((r) => r.id === after!.entries[0]!.slotId)
            assert.isDefined(own)
            const option = menu.find((b) => b.slotId === own!.id)!
            assert.deepStrictEqual(
              { name: own!.branch_name, user: own!.branch_name_user, menuName: option.name },
              { name: choice || null, user: 1, menuName: choice || null },
              "local name/clear must move onto the replacement switch point and its branch menu option"
            )
            if (choice === "") {
              const renamed = `chats/${folder}/ST restored.jsonl`
              yield* run([files[0]!, [renamed, bytesChanged]])
              const restored = yield* snapshot(api, renamed)
              const slot = restored.rows.find((r) => r.id === restored.entries[0]!.slotId)!
              assert.deepStrictEqual(
                { name: slot.branch_name, user: slot.branch_name_user },
                { name: null, user: 1 },
                "a later custom filename must not undo the transferred clear"
              )
            }
          })
        )
      }
  }
)

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "N4 parent extends through nested switch point",
  (it) => {
    for (const choice of [null, "My inner", ""])
      it.effect(`keeps a single nested naming decision (${JSON.stringify(choice)})`, () =>
        Effect.gen(function* () {
          const folder = `N4-${choice === null ? 0 : choice === "" ? 2 : 1}`
          const common = [msg(folder + " greeting", 0), msg(folder + " hello", 1)]
          const outer = [...common, msg(folder + " outer", 2)]
          const child = [...outer, msg(folder + " inner", 3), msg(folder + " child tail", 4)]
          const files: [string, Uint8Array][] = [
            [`chats/${folder}/main.jsonl`, bytes([{ chat_metadata: {} }, ...common, msg(folder + " main", 2)])],
            [`chats/${folder}/Outer road.jsonl`, bytes([{ chat_metadata: { main_chat: "main" } }, ...outer])],
            [`chats/${folder}/Inner road.jsonl`, bytes([{ chat_metadata: { main_chat: "Outer road" } }, ...child])],
            [
              `chats/${folder}/Alternative road.jsonl`,
              bytes([{ chat_metadata: { main_chat: "Outer road" } }, ...outer, msg(folder + " alternative", 3)])
            ]
          ]
          const api = yield* run(files)
          const base = yield* snapshot(api, files[2]![0])
          if (choice !== null) yield* nameHere({ slotId: base.entries[3]!.slotId, name: choice })
          const before = yield* snapshot(api, files[2]![0])
          const changedOuter = bytes([
            { chat_metadata: { main_chat: "main" } },
            ...child.slice(0, 4),
            msg(folder + " outer new tail", 4)
          ])
          let after: Snapshot | undefined
          for (let pass = 0; pass < 2; pass++) {
            yield* run([files[0]!, [files[1]![0], changedOuter], files[2]!])
            const current = yield* snapshot(api, files[2]![0])
            const parent = yield* snapshot(api, files[1]![0])
            assert.deepStrictEqual(
              current.entries.map((e) => e.slotId),
              before.entries.map((e) => e.slotId),
              "child message path is unchanged"
            )
            assert.deepStrictEqual(
              current.entries.map((e) => e.version),
              before.entries.map((e) => e.version),
              "child selected versions are unchanged"
            )
            assert.strictEqual(
              parent.entries[3]!.slotId,
              before.entries[3]!.slotId,
              "parent really extends through the old named slot"
            )
            if (after) assert.deepStrictEqual(current, after, "unchanged replay")
            after = current
          }
          const name = choice === "" ? null : (choice ?? "Inner road")
          if (name !== null)
            assert.strictEqual(
              after!.entries.filter((e) => e.branchName === name).length,
              1,
              "an unchanged nested path must not acquire duplicate labels when its parent extends"
            )
          else {
            const ids = new Set(after!.entries.map((e) => e.slotId))
            assert.strictEqual(
              after!.rows.filter((r) => ids.has(r.id as SlotId) && r.branch_name_user === 1).length,
              1,
              "an unchanged nested path must not acquire duplicate local-clear flags when its parent extends"
            )
          }
        })
      )
  }
)

interface NameRow {
  id: SlotId
  parent: SlotId | null
  depth: number
  name: string | null
  user: number
}
interface NameRecord {
  source: string
  end?: SlotId | null
  last?: SlotId | null
  nameSlot?: SlotId | null
  named?: boolean
}
interface NameGraph {
  slots: Map<string, NameRow>
  records: Map<string, NameRecord>
}
const graph = (folder: string) =>
  Effect.gen(function* () {
    const [records, slots] = yield* fixtureSql(
      config.dataDir,
      [
        {
          sql: "SELECT payload_json FROM jobs WHERE kind = 'st-import-chat' AND json_extract(payload_json, '$.source') LIKE ?",
          params: [`chats/${folder}/%`]
        },
        {
          sql: `SELECT id, parent_slot_id AS parent, depth, branch_name AS name, branch_name_user AS user
            FROM slots WHERE chat_id IN (SELECT json_extract(payload_json, '$.chatId') FROM jobs
            WHERE kind = 'st-import-chat' AND json_extract(payload_json, '$.source') LIKE ?)`,
          params: [`chats/${folder}/%`]
        }
      ],
      { readOnly: true }
    )
    return {
      records: new Map(
        records!.map((r) => {
          const record = JSON.parse(r.payload_json as string) as NameRecord
          return [record.source, record]
        })
      ),
      slots: new Map((slots as unknown as NameRow[]).map((s) => [s.id, s]))
    }
  })
const recordedPath = (g: NameGraph, end: string | null | undefined) => {
  const path: NameRow[] = []
  for (let slot = end ? g.slots.get(end) : undefined; slot; slot = slot.parent ? g.slots.get(slot.parent) : undefined)
    path.unshift(slot)
  return path
}
const naming = (s: NameRow) => ({ name: s.name, user: s.user })

/** An oracle over before/after paths, independent of the writer's recursive SQL. */
const checkPlacement = (
  before: NameGraph,
  after: NameGraph,
  source: string,
  parent: string | null,
  imported: string | null
) => {
  const old = before.records.get(source)
  const record = after.records.get(source)!
  assert.isDefined(record, source)
  const path = recordedPath(after, record.end)
  const previous = old?.nameSlot ? before.slots.get(old.nameSlot) : undefined
  const parentRecord = parent ? after.records.get(parent) : undefined
  const parentIds = new Set(recordedPath(after, parentRecord?.end ?? parentRecord?.last).map((s) => s.id))
  // Existing choices are slot state. A parent adopting that slot cannot move the choice.
  const target =
    previous && path.some((s) => s.id === previous.id)
      ? after.slots.get(previous.id)
      : path.find((s) => !parentIds.has(s.id) && (!previous || !before.slots.has(s.id)))
  if (parent !== null && target) {
    assert.strictEqual(record.nameSlot, target.id, `${source}: remembered placement`)
    const targetBefore = before.slots.get(target.id)
    const expected =
      previous && previous.id !== target.id
        ? targetBefore?.user === 1
          ? naming(targetBefore)
          : naming(previous)
        : previous
          ? naming(previous)
          : targetBefore && (targetBefore.user === 1 || targetBefore.name !== null)
            ? naming(targetBefore)
            : { name: imported, user: 0 }
    assert.deepStrictEqual(naming(target), expected, `${source}: name and provenance travel together`)
    if (previous && previous.id !== target.id) {
      // A suffix copy must not keep a second copy of this file's old choice.
      const copied = path.find((s) => s.depth === previous.depth && s.id !== previous.id && s.id !== target.id)
      if (
        copied &&
        !before.slots.has(copied.id) &&
        naming(previous).name === copied.name &&
        previous.user === copied.user
      )
        assert.deepStrictEqual(naming(copied), { name: null, user: 0 }, `${source}: duplicate suffix choice`)
    }
  } else if (parent !== null) {
    assert.strictEqual(
      record.nameSlot ?? null,
      old?.nameSlot ?? null,
      `${source}: retain a temporarily unreachable choice`
    )
  }
  // This includes omitted files and abandoned paths. Import must never move/clear an
  // existing slot's decision to repair a different path, even if another file shares it.
  for (const [id, slot] of before.slots) {
    if (id === target?.id && parent !== null && !previous && slot.name === null && slot.user === 0) continue
    assert.deepStrictEqual(naming(after.slots.get(id)!), naming(slot), `existing slot ${id}`)
  }
  for (const [pathSource, r] of before.records) {
    if (pathSource === source) continue
    assert.deepStrictEqual(after.records.get(pathSource), r, `other recorded path ${pathSource}`)
  }
  // Check every recorded path, including old filenames and omitted files, for a
  // duplicated copy of its reachable naming choice. Fixture labels are distinct.
  for (const r of after.records.values()) {
    if (!r.nameSlot) continue
    const placement = after.slots.get(r.nameSlot)!
    const entries = recordedPath(after, r.end)
    if (placement.name !== null && entries.some((e) => e.id === placement.id))
      assert.strictEqual(
        entries.filter((e) => e.name === placement.name).length,
        1,
        `${r.source}: one placement per path`
      )
  }
}

type EditKind = "writer" | "swipe" | "delete" | "add" | "rename" | "remove" | "restore" | "local" | "clear" | "extend"
interface Edit {
  kind: EditKind
  file: number
  at: number
}
const editKinds: EditKind[] = [
  "writer",
  "swipe",
  "delete",
  "add",
  "rename",
  "remove",
  "restore",
  "local",
  "clear",
  "extend"
]
const randomTrace = (seed: number): Edit[] => {
  let state = seed >>> 0
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  // Shuffle each block so every seed covers every edit family in random order.
  const trace: Edit[] = []
  for (let block = 0; block < 3; block++) {
    const kinds = [...editKinds]
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = next() % (i + 1)
      ;[kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!]
    }
    for (const kind of kinds)
      trace.push({
        kind,
        file: kind === "extend" ? 1 : kind === "local" || kind === "clear" ? 1 + (next() % 3) : next() % 4,
        at: next() % 7
      })
  }
  return trace
}
let traceRun = 0
const replayTrace = (seed: number, edits: readonly Edit[]) =>
  Effect.gen(function* () {
    const folder = `Random${seed}-${traceRun++}`
    const api = yield* client()
    const common = [msg(`${folder} greeting`, 0), msg(`${folder} hello`, 1)]
    const outer = [...common, msg(`${folder} outer`, 2)]
    const files = [
      { name: "main", parent: null, messages: [...common, msg(`${folder} main`, 2)], present: true },
      { name: "Outer road", parent: 0, messages: outer, present: true },
      {
        name: "main - Branch #1",
        parent: 0,
        messages: [...common, msg(`${folder} auto`, 2), msg(`${folder} auto tail`, 3)],
        present: true
      },
      {
        name: "Inner road",
        parent: 1,
        messages: [...outer, msg(`${folder} inner`, 3), msg(`${folder} inner tail`, 4)],
        present: true
      }
    ]
    const source = (i: number) => `chats/${folder}/${files[i]!.name}.jsonl`
    const upload = Effect.fnUntraced(function* () {
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      for (const [i, file] of files.entries()) {
        if (!file.present) continue
        const parent = file.parent === null ? null : source(file.parent)
        const before = yield* graph(folder)
        const data = bytes([
          { chat_metadata: file.parent === null ? {} : { main_chat: files[file.parent]!.name } },
          ...file.messages
        ])
        const result = yield* sendStFile(importId, source(i), data, { card: "none" })
        assert.notInclude(["failed", "deferred"], result.outcome)
        const after = yield* graph(folder)
        checkPlacement(before, after, source(i), parent, file.name.includes(" - Branch #") ? null : file.name)
      }
    })
    yield* upload()
    for (const [step, edit] of edits.entries()) {
      const file = files[edit.file]!
      const at = edit.at % Math.max(1, file.messages.length)
      const message = file.messages[at]
      switch (edit.kind) {
        case "writer":
          if (message)
            file.messages[at] = { ...message, is_user: !message.is_user, name: message.is_user ? "Bot" : "User" }
          break
        case "swipe":
          if (message)
            file.messages[at] = {
              ...message,
              mes: `${folder} swipe ${step}`,
              ...{
                swipes: [message.mes, `${folder} swipe ${step}`],
                swipe_id: 1,
                swipe_info: [{ send_date: message.send_date }, { send_date: message.send_date }]
              }
            }
          break
        case "delete":
          file.messages.splice(at, 1)
          break
        case "add":
          file.messages.push(msg(`${folder} added ${step}`, file.messages.length))
          break
        case "rename": {
          if (!file.present) break
          // A filename change creates another source record that may match the same
          // graph. The old source record is retained, as for a removed file.
          file.name = `Renamed ${edit.file} ${step}`
          const before = yield* graph(folder)
          const { importId } = yield* api.StartStImport({ unsupported: [] })
          const data = bytes([
            { chat_metadata: file.parent === null ? {} : { main_chat: files[file.parent]!.name } },
            ...file.messages
          ])
          yield* sendStFile(importId, source(edit.file), data, { card: "none" })
          const after = yield* graph(folder)
          checkPlacement(before, after, source(edit.file), file.parent === null ? null : source(file.parent), file.name)
          break
        }
        case "remove":
          if (edit.file !== 0) file.present = false
          break
        case "restore":
          file.present = true
          break
        case "local":
        case "clear": {
          const before = yield* graph(folder)
          const placement = before.records.get(source(edit.file))?.nameSlot
          if (placement)
            yield* nameHere({
              slotId: placement,
              name: edit.kind === "clear" ? "" : `Local ${edit.file} ${step}`
            })
          break
        }
        case "extend":
          // Parent adopts a nested fork's old switch point (N4), without editing it.
          if (edit.file === 1)
            file.messages = [
              ...files[3]!.messages.slice(0, -1),
              msg(`${folder} extension ${step}`, files[3]!.messages.length - 1)
            ]
          break
      }
      yield* upload()
    }
    // Replaying an unchanged folder must also obey the invariant.
    yield* upload()
  }).pipe(Effect.scoped)

/** Delta debugging: remove chunks, then individual edits, replaying each candidate in a
 * fresh synthetic folder. Failures report a seed and a 1-minimal, directly replayable trace.
 */
const minimizedFailure = (seed: number, edits: readonly Edit[]) =>
  Effect.gen(function* () {
    let trace = [...edits]
    for (let chunk = Math.max(1, Math.floor(trace.length / 2)); chunk >= 1; chunk = Math.floor(chunk / 2)) {
      for (let start = 0; start < trace.length;) {
        const candidate = trace.slice(0, start).concat(trace.slice(start + chunk))
        const failed = yield* replayTrace(seed, candidate).pipe(
          Effect.exit,
          Effect.map((exit) => exit._tag === "Failure")
        )
        if (failed) {
          trace = candidate
          start = 0
        } else start += chunk
      }
    }
    return trace
  })

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "ST naming invariant across seeded folder edits",
  (it) => {
    for (const choice of [null, "local", "clear"] as const)
      it.effect(`isolates a replacement that collides with another fork's name (${choice})`, () =>
        replayTrace(913, [
          ...(choice === null ? [] : ([{ kind: choice, file: 1, at: 0 }] satisfies Edit[])),
          { kind: "writer", file: 3, at: 0 },
          { kind: "extend", file: 1, at: 5 }
        ])
      )
    for (const choice of [null, "local", "clear"] as const)
      it.effect(`protects shared history after parent writer then child swipe (${choice})`, () =>
        replayTrace(7, [
          ...(choice === null ? [] : ([{ kind: choice, file: 3, at: 0 }] satisfies Edit[])),
          { kind: "writer", file: 1, at: 0 },
          { kind: "swipe", file: 3, at: 1 }
        ])
      )
    for (const choice of [null, "local", "clear"] as const)
      it.effect(`retains an unreachable choice when truncation creates no suffix (${choice})`, () =>
        replayTrace(8, [
          ...(choice === null ? [] : ([{ kind: choice, file: 3, at: 0 }] satisfies Edit[])),
          { kind: "writer", file: 1, at: 0 },
          { kind: "delete", file: 3, at: 3 },
          { kind: "delete", file: 3, at: 3 }
        ])
      )
    it.effect("keeps the choice when a renamed main file belongs to another chat", () =>
      replayTrace(914, [
        { kind: "rename", file: 0, at: 0 },
        { kind: "writer", file: 1, at: 0 }
      ])
    )
    for (const seed of [41, 871, 20261026])
      it.effect(
        `seed ${seed}`,
        () =>
          Effect.gen(function* () {
            const edits = randomTrace(seed)
            const result = yield* replayTrace(seed, edits).pipe(Effect.exit)
            if (result._tag === "Failure") {
              const trace = yield* minimizedFailure(seed, edits)
              assert.fail(
                `seed ${seed}; minimal trace ${JSON.stringify(trace)}; original failure: ${String(result.cause)}`
              )
            }
          }),
        { timeout: 180_000 }
      )
  }
)

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "legacy collision and missing parent regressions",
  (it) => {
    for (const mode of [
      "legacy-custom",
      "legacy-auto",
      "missing-parent",
      "unresolved-parent",
      "legacy-missing-parent",
      "legacy-unresolved-parent"
    ])
      for (const choice of [null, "Local outer", ""])
        it.effect(`${mode}: ${JSON.stringify(choice)}`, () =>
          Effect.gen(function* () {
            const folder = `Fix5-${mode}-${choice === null ? 0 : choice === "" ? 2 : 1}`
            const outerName = mode === "legacy-auto" ? "main - Branch #1" : "Outer road"
            const files = pair(folder, outerName)
            const common = [msg(folder + " greeting", 0), msg(folder + " hello", 1)]
            const outer = [...common, msg(folder + " fork", 2), msg(folder + " reply", 3)]
            const api = yield* run(files)
            const base = yield* snapshot(api, files[1]![0])
            if (choice !== null) yield* nameHere({ slotId: base.entries[2]!.slotId, name: choice })
            const before = yield* snapshot(api, files[1]![0])
            let childBefore: Snapshot | undefined
            const childSource = `chats/${folder}/Inner road.jsonl`
            let replacement: Uint8Array
            if (mode.endsWith("missing-parent") || mode.endsWith("unresolved-parent")) {
              // A legacy custom-name record has `named` only: no placement, no retained parent.
              if (mode.startsWith("legacy-"))
                yield* fixtureSql(config.dataDir, [
                  {
                    sql: "UPDATE jobs SET payload_json=json_remove(payload_json, '$.nameSlot', '$.parentRecordId') WHERE id=?",
                    params: [before.record.recordId]
                  }
                ])
              replacement = bytes([
                { chat_metadata: mode.endsWith("unresolved-parent") ? { main_chat: "Missing parent" } : {} },
                { ...outer[0]!, is_user: true, name: "User" },
                ...outer.slice(1)
              ])
            } else {
              const child = [
                { ...outer[0]!, is_user: true, name: "User" },
                ...outer.slice(1, 3),
                msg(folder + " inner", 3),
                msg(folder + " child tail", 4)
              ]
              yield* run([
                [
                  childSource,
                  bytes([{ chat_metadata: { main_chat: outerName } }, ...outer.slice(0, 3), ...child.slice(3)])
                ]
              ])
              yield* run([[childSource, bytes([{ chat_metadata: { main_chat: outerName } }, ...child])]])
              childBefore = yield* snapshot(api, childSource)
              yield* fixtureSql(config.dataDir, [
                {
                  sql:
                    mode === "legacy-auto"
                      ? "UPDATE jobs SET payload_json=json_remove(payload_json, '$.nameSlot', '$.named', '$.parentRecordId') WHERE id=?"
                      : "UPDATE jobs SET payload_json=json_remove(payload_json, '$.nameSlot', '$.parentRecordId') WHERE id=?",
                  params: [before.record.recordId]
                }
              ])
              replacement = bytes([
                { chat_metadata: { main_chat: "main" } },
                ...child.slice(0, -1),
                msg(folder + " extended", 4)
              ])
            }
            let after: Snapshot | undefined
            for (let pass = 0; pass < 2; pass++) {
              yield* run([files[0]!, [files[1]![0], replacement]])
              const current = yield* snapshot(api, files[1]![0])
              if (after) assert.deepStrictEqual(contents(current.entries), contents(after.entries), "unchanged replay")
              after = current
            }
            const expected = {
              name: choice === "" ? null : (choice ?? (mode === "legacy-auto" ? null : outerName)),
              user: choice === null ? 0 : 1
            }
            const old = after!.rows.find((r) => r.id === before.entries[2]!.slotId)!
            assert.deepStrictEqual(
              { name: old.branch_name, user: old.branch_name_user },
              expected,
              "original naming choice"
            )
            const oldPath = yield* api.ReadPath({
              chatId: before.record.chatId,
              leafSlotId: before.record.end,
              range: { _tag: "Bottom" },
              limit: 100
            })
            assert.deepStrictEqual(contents(oldPath.entries), contents(before.entries), "original path and versions")
            if (childBefore)
              assert.deepStrictEqual(
                contents((yield* snapshot(api, childSource)).entries),
                contents(childBefore.entries),
                "other file path and naming"
              )
            const row = after!.rows.find((r) => r.id === after!.entries[0]!.slotId)!
            assert.deepStrictEqual(
              { name: row.branch_name, user: row.branch_name_user },
              expected,
              "remembered choice follows replacement"
            )
          })
        )
    // A legacy custom-name record with a deeper local choice on its path: a slot changed before
    // migration 0043 (which marked every revision mismatch local), or a deeper fork point named
    // here. With the parent resolving, its own divergence still carries its choice.
    for (const deeper of ["migrated-hide", "named-deeper"])
      for (const choice of [null, "Local outer"])
        it.effect(`legacy record with a deeper local choice (${deeper}): ${JSON.stringify(choice)}`, () =>
          Effect.gen(function* () {
            const folder = `Verify6-${deeper}-${choice === null ? 0 : 1}`
            const common = [msg(folder + " greeting", 0), msg(folder + " hello", 1)]
            const outer = [
              ...common,
              msg(folder + " fork", 2),
              msg(folder + " reply", 3),
              msg(folder + " more", 4),
              msg(folder + " last", 5)
            ]
            const mainFile = pair(folder, "Outer road")[0]!
            const source = `chats/${folder}/Outer road.jsonl`
            const api = yield* run([mainFile, [source, bytes([{ chat_metadata: { main_chat: "main" } }, ...outer])]])
            const base = yield* snapshot(api, source)
            if (choice !== null) yield* nameHere({ slotId: base.entries[2]!.slotId, name: choice })
            if (deeper === "migrated-hide") {
              // A local change from before the upgrade, then migration 0043's statement.
              yield* api.SetMessageHidden({ slotId: base.entries[5]!.slotId, hidden: true })
              yield* fixtureSql(config.dataDir, [
                {
                  sql: "UPDATE slots SET branch_name_user = 1 WHERE row_version <> st_import_row_version AND id = ?",
                  params: [base.entries[5]!.slotId]
                }
              ])
            } else yield* nameHere({ slotId: base.entries[4]!.slotId, name: "Later scene" })
            const before = yield* snapshot(api, source)
            yield* fixtureSql(config.dataDir, [
              {
                sql: "UPDATE jobs SET payload_json=json_remove(payload_json, '$.nameSlot', '$.parentRecordId') WHERE id=?",
                params: [before.record.recordId]
              }
            ])
            const replacement = bytes([
              { chat_metadata: { main_chat: "main" } },
              { ...outer[0]!, is_user: true, name: "User" },
              ...outer.slice(1)
            ])
            let after: Snapshot | undefined
            for (let pass = 0; pass < 2; pass++) {
              yield* run([mainFile, [source, replacement]])
              const current = yield* snapshot(api, source)
              if (after) assert.deepStrictEqual(contents(current.entries), contents(after.entries), "unchanged replay")
              after = current
            }
            assert.notStrictEqual(after!.entries[0]!.slotId, before.entries[0]!.slotId, "path replaced")
            const oldPath = yield* api.ReadPath({
              chatId: before.record.chatId,
              leafSlotId: before.record.end,
              range: { _tag: "Bottom" },
              limit: 100
            })
            assert.deepStrictEqual(contents(oldPath.entries), contents(before.entries), "original path and versions")
            const row = after!.rows.find((r) => r.id === after!.entries[0]!.slotId)!
            assert.deepStrictEqual(
              { name: row.branch_name, user: row.branch_name_user },
              { name: choice ?? "Outer road", user: choice === null ? 0 : 1 },
              "the fork's own choice follows replacement"
            )
          })
        )
    // A legacy parent that extended through its child's named slot: the deeper choice is
    // the child's (its record remembers it), so the parent recovers its own.
    for (const choice of [null, "Local outer", ""])
      it.effect(`legacy parent extended through a child's choice: ${JSON.stringify(choice)}`, () =>
        Effect.gen(function* () {
          const folder = `Fix6-extended-${choice === null ? 0 : choice === "" ? 2 : 1}`
          const files = pair(folder, "Outer road")
          const outer = [
            msg(folder + " greeting", 0),
            msg(folder + " hello", 1),
            msg(folder + " fork", 2),
            msg(folder + " reply", 3)
          ]
          const childSource = `chats/${folder}/Inner road.jsonl`
          const child = [...outer, msg(folder + " inner", 4), msg(folder + " child tail", 5)]
          const api = yield* run([
            ...files,
            [childSource, bytes([{ chat_metadata: { main_chat: "Outer road" } }, ...child])]
          ])
          const base = yield* snapshot(api, files[1]![0])
          if (choice !== null) yield* nameHere({ slotId: base.entries[2]!.slotId, name: choice })
          const extended = [...child.slice(0, -1), msg(folder + " outer tail", 5)]
          yield* run([files[0]!, [files[1]![0], bytes([{ chat_metadata: { main_chat: "main" } }, ...extended])]])
          const before = yield* snapshot(api, files[1]![0])
          const childBefore = yield* snapshot(api, childSource)
          assert.strictEqual(
            childBefore.entries[4]!.branchName,
            "Inner road",
            "the child's name is on the extended path"
          )
          yield* fixtureSql(config.dataDir, [
            {
              sql: "UPDATE jobs SET payload_json=json_remove(payload_json, '$.nameSlot', '$.parentRecordId') WHERE id=?",
              params: [before.record.recordId]
            }
          ])
          const replacement = bytes([
            { chat_metadata: {} },
            { ...extended[0]!, is_user: true, name: "User" },
            ...extended.slice(1)
          ])
          let after: Snapshot | undefined
          for (let pass = 0; pass < 2; pass++) {
            yield* run([files[0]!, [files[1]![0], replacement]])
            const current = yield* snapshot(api, files[1]![0])
            if (after) assert.deepStrictEqual(contents(current.entries), contents(after.entries), "unchanged replay")
            after = current
          }
          assert.deepStrictEqual(
            contents((yield* snapshot(api, childSource)).entries),
            contents(childBefore.entries),
            "child path and naming"
          )
          const row = after!.rows.find((r) => r.id === after!.entries[0]!.slotId)!
          assert.deepStrictEqual(
            { name: row.branch_name, user: row.branch_name_user },
            { name: choice === "" ? null : (choice ?? "Outer road"), user: choice === null ? 0 : 1 },
            "the parent's own choice follows replacement"
          )
        })
      )
  }
)

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "parent divergence then child swipe preserves main",
  (it) => {
    // A legacy record (`named` only) whose parent's path has since moved off the old one
    // recovers its own choice, not the shared prefix where the parent now diverges.
    for (const legacy of [false, true])
      for (const choice of [null, "My inner", ""])
        it.effect(
          `${legacy ? "legacy record, " : ""}raw shared-root and abandoned-path fields (${JSON.stringify(choice)})`,
          () =>
            Effect.gen(function* () {
              const folder = `N7-${legacy ? "legacy-" : ""}${choice === null ? 0 : choice === "" ? 2 : 1}`
              const files = pair(folder, "Outer road")
              const outer = [
                msg(folder + " greeting", 0),
                msg(folder + " hello", 1),
                msg(folder + " fork", 2),
                msg(folder + " reply", 3)
              ]
              const child = [...outer.slice(0, 3), msg(folder + " inner", 3), msg(folder + " tail", 4)]
              const source = `chats/${folder}/Inner road.jsonl`
              const childFile = (): [string, Uint8Array] => [
                source,
                bytes([{ chat_metadata: { main_chat: "Outer road" } }, ...child])
              ]
              const api = yield* run([...files, childFile()])
              const initial = yield* snapshot(api, source)
              if (choice !== null) yield* nameHere({ slotId: initial.entries[3]!.slotId, name: choice })
              const before = yield* snapshot(api, source)
              if (legacy)
                yield* fixtureSql(config.dataDir, [
                  {
                    sql: "UPDATE jobs SET payload_json=json_remove(payload_json, '$.nameSlot', '$.parentRecordId') WHERE id=?",
                    params: [before.record.recordId]
                  }
                ])
              const main = yield* snapshot(api, files[0]![0])
              outer[0] = { ...outer[0]!, is_user: true, name: "User" }
              const outerFile: [string, Uint8Array] = [
                files[1]![0],
                bytes([{ chat_metadata: { main_chat: "main" } }, ...outer])
              ]
              yield* run([files[0]!, outerFile, childFile()])
              assert.deepStrictEqual(
                contents((yield* snapshot(api, source)).entries),
                contents(before.entries),
                "parent-only change"
              )
              const original = child[1]!
              child[1] = msg(folder + " changed user", 1, {
                swipes: [original.mes, folder + " changed user"],
                swipe_id: 1,
                swipe_info: [{ send_date: original.send_date }, { send_date: original.send_date }]
              })
              let after: Snapshot | undefined
              for (let pass = 0; pass < 2; pass++) {
                yield* run([files[0]!, outerFile, childFile()])
                const current = yield* snapshot(api, source)
                if (after) assert.deepStrictEqual(current, after, "stable replay")
                after = current
              }
              const mainAfter = yield* snapshot(api, files[0]![0])
              assert.deepStrictEqual(
                contents(mainAfter.entries),
                contents(main.entries),
                "main path and selected versions"
              )
              const root = main.rows.find((r) => r.id === main.entries[0]!.slotId)!
              assert.deepStrictEqual(
                mainAfter.rows.find((r) => r.id === root.id),
                root,
                "raw main root naming and provenance"
              )
              const oldPath = yield* api.ReadPath({
                chatId: before.record.chatId,
                leafSlotId: before.record.end,
                range: { _tag: "Bottom" },
                limit: 100
              })
              assert.deepStrictEqual(
                contents(oldPath.entries),
                contents(before.entries),
                "abandoned child path and selected versions"
              )
              const row = after!.rows.find((r) => r.id === after!.entries[1]!.slotId)!
              assert.deepStrictEqual(
                { name: row.branch_name, user: row.branch_name_user },
                { name: choice === "" ? null : (choice ?? "Inner road"), user: choice === null ? 0 : 1 },
                "choice placed on independent suffix"
              )
            })
        )
  }
)
