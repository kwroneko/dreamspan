// The page side of the display worker treats every worker message as hostile: the plugin
// shares the worker's global, so it can post anything, at any time, in any amount.
import { afterEach, expect, it, vi } from "vitest"
import type { ClientPlugin } from "@rp/shared/pluginClient.ts"
import { startDisplayPlugin } from "../src/displayPlugin.ts"
import { clientPluginHost, loadClientPlugin } from "../src/plugins.tsx"
import { timelineResult, displayListResult } from "../src/displayAdapter.ts"
import { displayTransforms } from "../src/features/chat/displayPipeline.ts"
import { displayScriptLists, builtinDisplayScriptLists } from "../src/features/chat/displayScripts.ts"
import { messageRows, timelineRows, type TimelineContext } from "../src/features/chat/timelineContributions.tsx"
import type { ChatView } from "../src/features/chat/session.ts"
import type { PathEntry } from "@rp/shared/chat.ts"

it("a retained message row keeps its own message, range and anchor whatever the copy says", () => {
  const entries = [0, 1].map((depth) => ({ slotId: `slot-${depth}`, depth, version: null })) as unknown as PathEntry[]
  const context: TimelineContext = {
    view: { entries } as unknown as ChatView,
    lcm: null,
    summaries: false,
    divider: -1,
    historyDivider: -1
  }
  const rows = messageRows(entries)
  // The copy returns the first row's key with the second message's identity and range.
  const [forged] = timelineRows(
    [
      {
        key: "slot-0",
        estimate: 300,
        from: 1,
        to: 1,
        lastSlotId: "slot-1",
        entry: { slotId: "slot-1", depth: 1, version: null }
      }
    ],
    rows,
    context
  )
  expect(forged!.entry).toBe(entries[0])
  expect([forged!.from, forged!.to, forged!.lastSlotId]).toEqual([0, 0, undefined])
  expect(forged!.estimate).toBe(300)
  expect(forged!.render).toBe(rows[0]!.render)
})

const plugin = (registry: string, id: string): ClientPlugin => ({
  scope: "user",
  id: "display-copy",
  commit: "a".repeat(40),
  manifest: {
    api: 1,
    id: "display-copy",
    name: "Changed display",
    client: "client.ts",
    server: null,
    worker: null,
    surfaces: [`client:${registry}`],
    replaces: [`${registry}:${id}`],
    overrides: [],
    network: false,
    base: null
  }
})

interface Posted {
  readonly kind: string
  readonly seq?: number
  readonly input?: unknown
}
/** A worker the test drives by hand. `ready` is what it answers activation with. */
const fakeWorker = (ready: (job: Posted) => unknown = (job) => ({ kind: "ready", seq: job.seq, entries: [] })) => {
  const state = {
    posted: [] as Posted[],
    terminated: 0,
    emit: (_data: unknown) => {}
  }
  class Fake {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    constructor() {
      state.emit = (data) => this.onmessage?.({ data })
    }
    terminate() {
      state.terminated++
    }
    postMessage(job: Posted) {
      state.posted.push(job)
      if (job.kind === "init") queueMicrotask(() => this.onmessage?.({ data: ready(job) }))
    }
  }
  vi.stubGlobal("Worker", Fake)
  return state
}
const dom = () => vi.stubGlobal("document", { activeElement: null, body: {}, querySelector: () => null })
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("a worker that keeps posting while nothing was asked is stopped", async () => {
  const worker = fakeWorker()
  const started = startDisplayPlugin(plugin("displayTransforms", "display.macros"), "/approved/client.mjs")
  await started.ready
  let faults = 0
  started.bridge.onFault!(() => faults++)
  const answer = started.bridge.call("displayTransforms", "display.macros", {})
  await turn()
  const call = worker.posted.at(-1)!
  worker.emit({ kind: "result", seq: call.seq, value: { text: "x", issues: [] } })
  await answer
  expect(worker.terminated).toBe(0)
  // Nothing is in flight now: a flood of further "results" is not an answer to anything.
  worker.emit({ kind: "result", seq: call.seq, value: { text: "y".repeat(1000), issues: [] } })
  expect(worker.terminated).toBe(1)
  // No call was waiting to fail, so the stop is reported on its own: the copy shows as failed.
  expect(faults).toBe(1)
  started.bridge.close()
  expect(faults).toBe(1)
  await expect(started.bridge.call("displayTransforms", "display.macros", {})).rejects.toThrow()
})

it("an answer that arrived while the page was busy past the deadline is still read", async () => {
  vi.useFakeTimers()
  const worker = fakeWorker()
  const started = startDisplayPlugin(plugin("displayTransforms", "display.macros"), "/approved/client.mjs")
  await started.ready
  const answer = started.bridge.call("displayTransforms", "display.macros", {})
  const call = worker.posted.at(-1)!
  // The deadline timer has fired; the answer's message event is the next task.
  await vi.advanceTimersByTimeAsync(50)
  worker.emit({ kind: "result", seq: call.seq, value: { text: "in time", issues: [] } })
  await expect(answer).resolves.toEqual({ text: "in time", issues: [] })
  await vi.advanceTimersByTimeAsync(10)
  expect(worker.terminated).toBe(0)
})

it("an answer posted before its call was sent cannot answer that call", async () => {
  const worker = fakeWorker()
  const started = startDisplayPlugin(plugin("displayTransforms", "display.macros"), "/approved/client.mjs")
  await started.ready
  const first = started.bridge.call("displayTransforms", "display.macros", { text: "first" })
  const second = started.bridge.call("displayTransforms", "display.macros", { text: "second" })
  second.catch(() => {})
  await turn()
  const call = worker.posted.at(-1)!
  worker.emit({ kind: "result", seq: call.seq, value: { text: "for first", issues: [] } })
  await first
  await turn()
  // The second call is in flight; the worker repeats the first call's envelope.
  worker.emit({ kind: "result", seq: call.seq, value: { text: "forged for second", issues: [] } })
  await expect(second).rejects.toThrow()
  expect(worker.terminated).toBe(1)
})

it("messages that are not a known envelope stop the copy", async () => {
  for (const hostile of [null, "result", 7, [], { kind: "result" }, { kind: "bogus", seq: 2 }]) {
    const worker = fakeWorker()
    const started = startDisplayPlugin(plugin("displayTransforms", "display.macros"), "/approved/client.mjs")
    await started.ready
    const answer = started.bridge.call("displayTransforms", "display.macros", {})
    await turn()
    worker.emit(hostile)
    await expect(answer).rejects.toThrow()
    expect(worker.terminated).toBe(1)
  }
})

for (const [name, entries] of [
  ["more rules than a plugin may register", Array.from({ length: 1000 }, (_, i) => `example.rule${i}`)],
  ["an id that is not text", [["display.macros"]]],
  ["the same rule twice", ["example.one", "example.one"]]
] as const)
  it(`activation that announces ${name} registers nothing`, async () => {
    dom()
    const before = displayTransforms.list().length
    fakeWorker((job) => ({
      kind: "ready",
      seq: job.seq,
      entries: entries.map((id) => ({ registry: "displayTransforms", api: 1, id, order: 90 }))
    }))
    const p = plugin("displayTransforms", "display.macros")
    await loadClientPlugin({ ...p, id: `hostile-${name.length}`, manifest: { ...p.manifest, replaces: [] } })
    expect(displayTransforms.list().length).toBe(before)
  })

it("activation cannot register in a registry the plugin did not declare", async () => {
  dom()
  const stops = builtinDisplayScriptLists.map((list) => displayScriptLists.register(list))
  try {
    const before = displayScriptLists.get("display-regex.global")
    fakeWorker((job) => ({
      kind: "ready",
      seq: job.seq,
      entries: [{ registry: "displayScriptLists", api: 1, id: "display-regex.global", order: 10 }]
    }))
    const p = plugin("displayTransforms", "display.macros")
    await loadClientPlugin({
      ...p,
      id: "undeclared",
      manifest: { ...p.manifest, replaces: ["displayScriptLists:display-regex.global"] }
    })
    expect(displayScriptLists.get("display-regex.global")).toBe(before)
  } finally {
    stops.forEach((stop) => stop())
  }
})

it("timeline output is rebuilt from the contract's fields and bounded in total", () => {
  const body = Object.assign(Object.create(null), { kind: "text", text: "Shown", onClick: "bad" }) as object
  Object.defineProperty(body, "__proto__", { value: { polluted: true }, enumerable: true })
  const [row] = timelineResult([{ key: "notice", estimate: 44, from: Infinity, to: -1, body, render: "bad", extra: 1 }])
  expect(Object.keys(row!).sort()).toEqual(["body", "estimate", "from", "key", "to"])
  expect(Object.keys(row!.body!).sort()).toEqual(["kind", "text"])
  expect(Object.getPrototypeOf(row!.body)).toBe(Object.prototype)
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  const big = Array.from({ length: 20 }, (_, i) => ({
    key: `big${i}`,
    estimate: 44,
    from: Infinity,
    to: -1,
    body: { kind: "text", text: "x".repeat(150_000) }
  }))
  expect(() => timelineResult(big)).toThrow()
})

it("a script list answer is bounded in total size", () => {
  const script = {
    id: "s",
    name: "Synthetic",
    find_regex: "a",
    replace_string: "x".repeat(300_000),
    trim_strings: [],
    placement: [2],
    disabled: false,
    markdown_only: true,
    prompt_only: false,
    run_on_edit: false,
    substitute_regex: "none",
    min_depth: null,
    max_depth: null
  }
  expect(displayListResult([script]).length).toBe(1)
  expect(() => displayListResult(Array.from({ length: 10 }, (_, i) => ({ ...script, id: `s${i}` })))).toThrow()
})

it("superseded work leaves the queue: a busy screen cannot turn a working copy off", async () => {
  const worker = fakeWorker()
  const started = startDisplayPlugin(plugin("displayTransforms", "display.macros"), "/approved/client.mjs")
  await started.ready
  const outcomes: string[] = []
  // 400 rows re-render before the worker answers the first: each abandons its previous call.
  let last: Promise<unknown> | undefined
  for (let i = 0; i < 400; i++) {
    const controller = new AbortController()
    last = started.bridge.call("displayTransforms", "display.macros", { text: `v${i}` }, controller.signal)
    last.then(
      () => outcomes.push("answered"),
      (error: Error) => outcomes.push(error.message)
    )
    if (i < 399) controller.abort()
  }
  await turn()
  expect(outcomes.filter((message) => /busy/i.test(message))).toEqual([])
  // Answer whatever is in flight until the newest call is answered: the first call was
  // already with the worker when it was abandoned, the newest follows it directly.
  let newest = false
  void last!.then(() => (newest = true))
  for (let i = 0; i < 3 && !newest; i++) {
    const call = worker.posted.at(-1)!
    if (call.kind === "call") worker.emit({ kind: "result", seq: call.seq, value: { text: "ok", issues: [] } })
    await turn()
  }
  await last
  expect(worker.terminated).toBe(0)
  // The abandoned calls were never sent to the worker at all.
  expect(worker.posted.filter((job) => job.kind === "call").length).toBeLessThanOrEqual(2)
})

it("a script list is asked once for the same scripts, however many messages show them", async () => {
  dom()
  const stops = builtinDisplayScriptLists.map((list) => displayScriptLists.register(list))
  let calls = 0
  const scope = clientPluginHost(plugin("displayScriptLists", "display-regex.global"), {
    close: () => {},
    call: async () => {
      calls++
      return []
    }
  })
  try {
    scope.host.registries.displayScriptLists!.register({
      api: 1,
      id: "display-regex.global",
      order: 10,
      scripts: () => []
    })
    const global: never[] = []
    const preset: never[] = []
    const character: never[] = []
    const list = displayScriptLists.get("display-regex.global")!
    await Promise.all(
      Array.from({ length: 200 }, () =>
        list.asyncScripts!({ global, preset, character, characterId: null, placement: 2 })
      )
    )
    expect(calls).toBe(1)
    await list.asyncScripts!({ global, preset, character, characterId: null, placement: 1 })
    await list.asyncScripts!({ global: [], preset, character, characterId: null, placement: 2 })
    expect(calls).toBe(3)
  } finally {
    scope.close()
    stops.forEach((stop) => stop())
  }
})
