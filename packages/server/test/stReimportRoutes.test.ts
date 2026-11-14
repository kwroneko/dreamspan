// The re-import preview maps a folder's files as the import does (ARCHITECTURE.md §13
// "Re-import preview"), however its branches nest: random synthetic folders of chats and
// branches up to four deep, some new, renamed, duplicated or with their parent missing, are
// imported, changed, checked by path and imported again from the check. Every file the check
// read must be imported, none refused (each one's write held to the check's per-message
// outcomes in its transaction, `StImportCommitChat`), and each chat here must gain exactly the
// messages and swipes the check counted for it.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { assert, layer } from "@effect/vitest"
import { ST_CHANGED_SINCE_CHECK } from "@rp/shared/stReimportPlan.ts"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { stImportGraph } from "./support/stImportGraph.ts"
import { importStPath, jobEnded } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const config = testConfig()
const TREES = 8

/** A small seeded generator (mulberry32), so a failing tree can be made again. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

interface Line {
  readonly mes: string
  readonly minute: number
  readonly swipes?: ReadonlyArray<string>
}

/** A file: its messages (Alice and Sam taking turns), and the file it names as its parent. */
interface Chat {
  lines: Array<Line>
  readonly parent: string | null
}

/** Each tree's files are named apart (`prefix`): a tree's chats are never another's. */
const bytesOf = (chat: Chat, prefix: string) =>
  jsonl([
    header(chat.parent === null ? {} : { main_chat: `${prefix}${chat.parent}` }),
    ...chat.lines.map((line, i) =>
      message({
        name: i % 2 ? "Sam" : "Alice",
        user: i % 2 === 1,
        mes: line.mes,
        minute: line.minute,
        ...(line.swipes === undefined ? {} : { swipes: line.swipes, swipeId: line.swipes.indexOf(line.mes) })
      })
    )
  ])

const own = (tag: string, from: number, count: number): Array<Line> =>
  Array.from({ length: count }, (_, i) => ({ mes: `${tag} ${from + i}`, minute: from + i }))

/** A branch of `parent`: its first messages, then its own. */
const branchOf = (parent: Chat, name: string, pick: () => number, tag: string): Chat => {
  const cut = 1 + Math.floor(pick() * parent.lines.length)
  return { lines: [...parent.lines.slice(0, cut), ...own(tag, cut, 1 + Math.floor(pick() * 4))], parent: name }
}

const write = (root: string, chats: ReadonlyMap<string, Chat>, prefix: string) => {
  rmSync(join(root, "chats"), { recursive: true, force: true })
  mkdirSync(join(root, "characters"), { recursive: true })
  writeFileSync(join(root, "characters/Alice.png"), card("Alice", "m0"))
  for (const [name, chat] of chats) {
    const path = join(root, `chats/Alice/${prefix}${name}.jsonl`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytesOf(chat, prefix))
  }
}

const planEnded = (api: Api, planId: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 120_000
    for (;;) {
      const plan = yield* api.GetStImportPlan({ planId })
      if (plan.status !== "running") return plan
      if (Date.now() > deadline) return yield* Effect.die(new Error("preview still running"))
      yield* Effect.sleep(20)
    }
  })

/** The tree a seed makes: what's imported first, and the folder as ST has it since. */
const tree = (seed: number) => {
  const pick = random(seed)
  const first = new Map<string, Chat>()
  const roots = 1 + Math.floor(pick() * 2)
  for (let r = 0; r < roots; r++) first.set(`Root${r}`, { lines: own(`root${r}`, 0, 3 + Math.floor(pick() * 5)), parent: null })
  // Branches already imported, one or two deep.
  for (let b = 0; b < Math.floor(pick() * 3); b++) {
    const names = [...first.keys()]
    const parent = names[Math.floor(pick() * names.length)]!
    first.set(`Old${b}`, branchOf(first.get(parent)!, parent, pick, `old${b}`))
  }
  const second = new Map([...first].map(([name, chat]) => [name, { lines: [...chat.lines], parent: chat.parent }]))
  // In ST since: messages added, a swipe added and chosen.
  for (const [name, chat] of second) {
    if (pick() < 0.6) chat.lines.push(...own(`more ${name}`, chat.lines.length, 1 + Math.floor(pick() * 3)))
    if (pick() < 0.4) {
      const at = Math.floor(pick() * chat.lines.length)
      const line = chat.lines[at]!
      chat.lines[at] = { ...line, mes: `${line.mes} swiped`, swipes: [line.mes, `${line.mes} swiped`] }
    }
  }
  // New branches, nested up to four deep under a file here, a new one, or one not in the folder.
  const depth = new Map<string, number>([...second.keys()].map((name) => [name, second.get(name)!.parent === null ? 0 : 1]))
  for (let n = 0; n < 2 + Math.floor(pick() * 5); n++) {
    const name = `New${n}`
    const roll = pick()
    if (roll < 0.1) {
      second.set(name, { lines: own(`orphan${n}`, 0, 3), parent: "Ghost" })
      depth.set(name, 1)
      continue
    }
    const candidates = [...second.keys()].filter((key) => (depth.get(key) ?? 0) < 4)
    const parent = candidates[Math.floor(pick() * candidates.length)]!
    const made = branchOf(second.get(parent)!, parent, pick, `new${n}`)
    second.set(name, made)
    depth.set(name, (depth.get(parent) ?? 0) + 1)
    // A copy of it under another name, or one renamed from it.
    if (roll > 0.85) second.set(`${name} copy`, { lines: [...made.lines], parent: made.parent })
  }
  if (pick() < 0.3) {
    // A file renamed in ST: what it held, under a name no import has seen.
    const [name, chat] = [...second].find(([, c]) => c.parent === null)!
    second.delete(name)
    second.set(`${name} renamed`, chat)
    for (const other of second.values()) if (other.parent === name) (other as { parent: string | null }).parent = `${name} renamed`
  }
  return { first, second }
}

layer(serverLayer(config), { excludeTestServices: true, timeout: "600 seconds" })("ST re-import routes", (it) => {
  it.effect("previews a new branch of a new branch of a chat here, as the import takes it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const root = tempDir("st-routes-nested")
      const base: Chat = { lines: own("base", 0, 4), parent: null }
      write(root, new Map([["Base", base]]), "")
      yield* importStPath(api, root)
      const chat = (yield* api.ListChats({ limit: 200, before: null })).find((c) => c.title === "Base")!
      const side: Chat = { lines: [...base.lines.slice(0, 2), ...own("side", 2, 4)], parent: "Base" }
      const nested: Chat = { lines: [...side.lines.slice(0, 4), ...own("nested", 4, 4)], parent: "Side" }
      write(root, new Map([["Base", base], ["Side", side], ["Nested", nested]]), "")
      const plan = yield* planEnded(api, (yield* api.StartStImportPlan({ folder: { root, prefix: "" } })).plan.planId)
      assert.strictEqual(plan.status, "done")
      assert.deepStrictEqual(
        plan.files.map((file) => [file.path, file.target, file.chatId, { ...file.counts }]),
        [
          ["chats/Alice/Base.jsonl", "existing", chat.id, { unchanged: 4, newMessages: 0, newSwipes: 0, selected: 0, kept: 0, branches: 0 }],
          ["chats/Alice/Side.jsonl", "branch", chat.id, { unchanged: 2, newMessages: 4, newSwipes: 0, selected: 0, kept: 0, branches: 1 }],
          // Its first four are Side's, which Side's file brings in this same import.
          ["chats/Alice/Nested.jsonl", "branch", chat.id, { unchanged: 4, newMessages: 4, newSwipes: 0, selected: 0, kept: 0, branches: 1 }]
        ]
      )
      assert.strictEqual(plan.newChats, 0)
      const before = yield* stImportGraph(config.dataDir, chat.id)
      const done = yield* jobEnded(
        api,
        (yield* api.StartStPathImport({ path: root, prefix: "", plan: { planId: plan.planId, skip: [] } })).importId
      )
      assert.deepStrictEqual(
        (done.report?.issues ?? []).filter((issue) => issue.code === ST_CHANGED_SINCE_CHECK),
        []
      )
      const after = yield* stImportGraph(config.dataDir, chat.id)
      assert.strictEqual(new Set(after.map((row) => row.id)).size - new Set(before.map((row) => row.id)).size, 8)
    })
  )

  it.effect("the check maps, counts and is held to every file as the import takes it", () =>
    Effect.gen(function* () {
      const api = yield* client()
      for (let seed = 1; seed <= TREES; seed++) {
        // Each tree a folder of its own, its files named apart from the other trees'.
        const root = tempDir(`st-routes-${seed}`)
        const prefix = `T${seed} `
        const { first, second } = tree(seed)
        write(root, first, prefix)
        const once = yield* importStPath(api, root)
        assert.strictEqual(once.job.status, "complete", `seed ${seed}`)
        write(root, second, prefix)
        const started = yield* api.StartStImportPlan({ folder: { root, prefix: "" } })
        const plan = yield* planEnded(api, started.plan.planId)
        assert.strictEqual(plan.status, "done", `seed ${seed}: ${plan.error}`)
        const chats = [...new Set(plan.files.flatMap((file) => (file.chatId === null ? [] : [file.chatId])))]
        const before = new Map<string, ReadonlyArray<{ id: string; content: string }>>()
        for (const chatId of chats) before.set(chatId, yield* stImportGraph(config.dataDir, chatId))
        const { importId } = yield* api.StartStPathImport({ path: root, prefix: "", plan: { planId: plan.planId, skip: [] } })
        const done = yield* jobEnded(api, importId)
        assert.strictEqual(done.job.status, "complete", `seed ${seed}`)
        const refused = (done.report?.issues ?? []).filter((issue) => issue.code === ST_CHANGED_SINCE_CHECK)
        assert.deepStrictEqual(
          refused.map((issue) => issue.path),
          [],
          `seed ${seed}: ${JSON.stringify([...second].map(([n, c]) => [n, c.parent, c.lines.length]))}`
        )
        for (const chatId of chats) {
          const after = yield* stImportGraph(config.dataDir, chatId)
          const was = before.get(chatId)!
          const slots = new Set(was.map((row) => row.id))
          const versions = new Set(was.map((row) => `${row.id}\n${row.content}`))
          const counted = plan.files.filter((file) => file.chatId === chatId && file.target !== "bin")
          assert.deepStrictEqual(
            {
              slots: new Set(after.filter((row) => !slots.has(row.id)).map((row) => row.id)).size,
              versions: after.filter((row) => slots.has(row.id) && !versions.has(`${row.id}\n${row.content}`)).length
            },
            {
              slots: counted.reduce((n, file) => n + file.counts.newMessages, 0),
              versions: counted.reduce((n, file) => n + file.counts.newSwipes, 0)
            },
            `seed ${seed}, chat of ${counted.map((file) => file.path).join(", ")}`
          )
        }
      }
    })
  )
})
