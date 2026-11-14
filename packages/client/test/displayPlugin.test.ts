import { afterEach, expect, it, vi } from "vitest"
import type { ClientPlugin } from "@rp/shared/pluginClient.ts"
import { DEFAULT_DISPLAY_PREFS } from "@rp/shared/chatApi.ts"
import { Version, type VersionId, type SlotId } from "@rp/shared/chat.ts"
import { startDisplayPlugin, DISPLAY_PLUGIN_DEADLINE_MS } from "../src/displayPlugin.ts"
import { clientPluginHost } from "../src/plugins.tsx"
import { displayInput, displayResult, timelineResult } from "../src/displayAdapter.ts"
import { displayTransforms, macroDisplay, type DisplayInput } from "../src/features/chat/displayPipeline.ts"
import { macroDisplayPart } from "../src/features/chat/displayParts.ts"
import {
  displayScriptLists,
  builtinDisplayScriptLists,
  displayScriptsAsync
} from "../src/features/chat/displayScripts.ts"
import {
  timelineTransforms,
  timelineBodies,
  timelineInput,
  timelineRows,
  messageRows,
  type TimelineContext
} from "../src/features/chat/timelineContributions.tsx"
import type { ChatView } from "../src/features/chat/session.ts"

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
const input: DisplayInput = {
  text: "Hi {{user}}",
  version: new Version({
    id: "v" as VersionId,
    slotId: "s" as SlotId,
    ordinal: 1,
    status: "complete",
    speakerEntityId: null,
    writer: "model",
    content: "Hi {{user}}",
    macroMode: "verbatim",
    origin: "generated",
    sourceVersionId: null,
    direction: null,
    hidden: false,
    starred: false,
    createdAt: 0,
    model: null,
    error: null,
    mark: null,
    frozenMacros: null,
    context: null,
    rowVersion: 0
  }),
  names: { user: "Ana", char: "Mira" },
  card: {},
  prefs: { ...DEFAULT_DISPLAY_PREFS, outputMacros: true },
  scripts: [],
  placement: 2,
  depth: 0,
  streaming: true
}
const dom = () => vi.stubGlobal("document", { activeElement: null, body: {}, querySelector: () => null })
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("projects explicit rendering fields before touching unknown version/settings/card data", () => {
  const bad = {
    get secret() {
      throw new Error("must not read")
    }
  }
  const projected = displayInput({
    ...input,
    version: { ...input.version, ...Object.getOwnPropertyDescriptors(bad) } as Version,
    card: Object.defineProperty({}, "ownTurnNotes", Object.getOwnPropertyDescriptor(bad, "secret")!),
    prefs: Object.defineProperty({ ...input.prefs }, "credentials", Object.getOwnPropertyDescriptor(bad, "secret")!)
  })
  expect(Object.keys(projected.version)).toEqual(["macroMode", "writer", "frozenMacros"])
  expect(projected.prefs).toEqual({ outputMacros: true, displayRegex: true })
  expect(projected.card).toEqual({})
  expect(projected.streaming).toBe(true)
  expect(projected).not.toHaveProperty("session")
})

it("a copied transform runs only through its worker bridge and restores exact original identity", async () => {
  dom()
  const undo = displayTransforms.register({ ...macroDisplayPart, transform: macroDisplay })
  const original = displayTransforms.get("display.macros")!
  const seen: unknown[] = []
  const scope = clientPluginHost(plugin("displayTransforms", "display.macros"), {
    close: () => {},
    call: async (_registry, _id, data) => {
      seen.push(data)
      return { text: "Changed", issues: [] }
    }
  })
  try {
    scope.host.registries.displayTransforms!.register({
      ...macroDisplayPart,
      transform: () => {
        throw new Error("page callback must never run")
      }
    })
    expect(await displayTransforms.get(original.id)!.transform(input)).toEqual({ text: "Changed", issues: [] })
    expect(seen).toEqual([displayInput(input)])
    const other = clientPluginHost(
      { ...plugin("displayTransforms", original.id), id: "other" },
      { call: async () => null, close: () => {} }
    )
    expect(() => other.host.registries.displayTransforms!.register(macroDisplayPart)).toThrow("owned")
    other.close()
    scope.close()
    expect(displayTransforms.get(original.id)).toBe(original)
    expect(await original.transform(input)).toEqual({ text: "Hi Ana", issues: [] })
  } finally {
    scope.close()
    undo()
  }
})

for (const failure of [
  () => {
    throw new Error("bad rule")
  },
  () => ({ text: 3, issues: [] }),
  () => ({ text: "x".repeat(1_000_001), issues: [] })
])
  it("a thrown or invalid output restores this call and turns the entire copy off", async () => {
    dom()
    const undo = displayTransforms.register({ ...macroDisplayPart, transform: macroDisplay })
    const original = displayTransforms.get("display.macros")!
    const scope = clientPluginHost(plugin("displayTransforms", original.id), {
      close: () => {},
      call: async () => failure()
    })
    try {
      scope.host.registries.displayTransforms!.register(macroDisplayPart)
      const retained = displayTransforms.get(original.id)!
      expect(await retained.transform(input)).toEqual(macroDisplay(input))
      expect(displayTransforms.get(original.id)).toBe(original)
      expect(await retained.transform(input)).toEqual(macroDisplay(input))
    } finally {
      scope.close()
      undo()
    }
  })

it("script lists use a worker and preserve approved-only input and original ordering after closure", async () => {
  dom()
  const stops = builtinDisplayScriptLists.map((list) => displayScriptLists.register(list))
  const original = displayScriptLists.get("display-regex.preset")!
  const scope = clientPluginHost(plugin("displayScriptLists", original.id), { close: () => {}, call: async () => [] })
  const context = { global: [], preset: [], character: [], characterId: null, placement: 6 }
  try {
    scope.host.registries.displayScriptLists!.register({
      api: 1,
      id: original.id,
      order: original.order,
      scripts: () => {
        throw new Error("page")
      }
    })
    expect(await displayScriptsAsync(displayScriptLists.list(), context)).toEqual([])
    scope.close()
    expect(displayScriptLists.get(original.id)).toBe(original)
  } finally {
    scope.close()
    stops.reverse().forEach((stop) => stop())
  }
})

it("a timeline copy returns validated data; retained renderers and unknown bodies cannot cross", async () => {
  dom()
  const id = "timeline.lcm"
  const undo = timelineTransforms.register({ id, order: 20, transform: (rows) => rows })
  const original = timelineTransforms.get(id)!
  const scope = clientPluginHost(plugin("timelineTransforms", id), {
    close: () => {},
    call: async () => [{ key: "notice", estimate: 44, from: Infinity, to: -1, body: { kind: "text", text: "Changed" } }]
  })
  const context: TimelineContext = {
    view: { entries: [] } as unknown as ChatView,
    lcm: null,
    summaries: false,
    divider: -1,
    historyDivider: -1
  }
  try {
    scope.host.registries.timelineTransforms!.register({ api: 1, id, order: 20, transform: () => [] })
    const result = await timelineTransforms.get(id)!.asyncTransform!(messageRows([]), context)
    expect(result[0]?.body).toEqual({ kind: "text", text: "Changed" })
    expect(timelineInput(result, context).rows[0]).not.toHaveProperty("render")
    expect(() => timelineResult([{ ...result[0], body: { kind: "executable" } }])).toThrow()
    expect(() => timelineRows([{ key: "forged", estimate: 44, from: 0, to: 0 }], [], context)).toThrow("Unknown")
    scope.close()
    expect(timelineTransforms.get(id)).toBe(original)
  } finally {
    scope.close()
    undo()
  }
})

it("the 50 ms callback deadline terminates a worker and rejects queued work, without blocking the page", async () => {
  vi.useFakeTimers()
  const terminate = vi.fn()
  class SlowWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    terminate = terminate
    postMessage(job: { kind: string }) {
      if (job.kind === "init") queueMicrotask(() => this.onmessage?.({ data: { kind: "ready", entries: [] } }))
    }
  }
  vi.stubGlobal("Worker", SlowWorker)
  const worker = startDisplayPlugin(plugin("displayTransforms", "display.macros"), "/approved/client.mjs")
  await worker.ready
  const first = worker.bridge.call("displayTransforms", "display.macros", displayInput(input))
  const queued = worker.bridge.call("displayTransforms", "display.macros", displayInput(input))
  const results = Promise.allSettled([first, queued])
  await vi.advanceTimersByTimeAsync(DISPLAY_PLUGIN_DEADLINE_MS)
  expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"])
  expect(terminate).toHaveBeenCalledTimes(1)
  await expect(worker.bridge.call("displayTransforms", "display.macros", {})).rejects.toThrow("off")
})

it("rejects malformed text, explanations and duplicate timeline keys", () => {
  for (const value of [null, { text: "x", issues: [3] }, { text: "x", issues: Array(101).fill("issue") }])
    expect(() => displayResult(value)).toThrow()
  const row = { key: "same", estimate: 40, from: Infinity, to: -1 }
  expect(() => timelineResult([row, row])).toThrow()
  for (const extra of [
    { from: NaN },
    { from: -Infinity },
    { from: 0.5 },
    { to: Infinity },
    { lastSlotId: 3 },
    { entry: { slotId: "x", depth: -1, version: null } }
  ])
    expect(() => timelineResult([{ ...row, ...extra }])).toThrow()
})

it("normal closure gives worker cleanup a bounded turn, then terminates even if cleanup hangs", async () => {
  vi.useFakeTimers()
  const terminate = vi.fn(),
    messages: unknown[] = []
  class CleanupWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror = null
    terminate = terminate
    postMessage(job: { kind: string }) {
      messages.push(job)
      if (job.kind === "init") queueMicrotask(() => this.onmessage?.({ data: { kind: "ready", entries: [] } }))
      // Deliberately never acknowledge dispose: cleanup is not allowed to hang.
    }
  }
  vi.stubGlobal("Worker", CleanupWorker)
  const worker = startDisplayPlugin(plugin("displayTransforms", "display.macros"), "/approved/client.mjs")
  await worker.ready
  worker.bridge.close()
  expect(messages).toContainEqual({ kind: "dispose" })
  await expect(worker.bridge.call("displayTransforms", "display.macros", {})).rejects.toThrow("off")
  expect(terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(DISPLAY_PLUGIN_DEADLINE_MS)
  expect(terminate).toHaveBeenCalledTimes(1)
})

it("timeline presentation resolves registered bodies and restores them on disposal", () => {
  const context: TimelineContext = {
    view: { entries: [] } as unknown as ChatView,
    lcm: null,
    summaries: false,
    divider: -1,
    historyDivider: -1
  }
  const before = timelineBodies.get("history")
  const stop = timelineBodies.register({
    id: "history",
    source: import.meta.url,
    row: (_body, _context, fields) => ({ ...fields, render: () => "Registered view" })
  })
  const data = [{ key: "test-history", estimate: 44, from: Infinity, to: -1, body: { kind: "history" } }]
  try {
    const row = timelineRows(data, [], context)[0]!
    expect(row.render({} as Parameters<typeof row.render>[0])).toBe("Registered view")
  } finally {
    stop()
  }
  expect(timelineBodies.get("history")).toBe(before)
})

it("new display contributions are not labelled as replacements, and a failed worker still closes the scope", async () => {
  dom()
  const p = plugin("displayTransforms", "display.macros")
  const scope = clientPluginHost(
    { ...p, manifest: { ...p.manifest, replaces: [] } },
    {
      close: () => {},
      call: async () => {
        throw new Error("new rule failed")
      }
    }
  )
  scope.host.registries.displayTransforms!.register({ ...macroDisplayPart, id: "example.new-display" })
  const entry = displayTransforms.get("example.new-display")!
  expect(entry.replacement).toBeUndefined()
  expect(entry.needsContext).toBe(true)
  expect(await entry.transform(input)).toEqual({ text: input.text, issues: [] })
  expect(displayTransforms.get(entry.id)).toBeUndefined()
  expect(() => scope.host.registries.displayTransforms!.register({ ...macroDisplayPart, id: "example.late" })).toThrow(
    "off"
  )
  scope.close()
})
