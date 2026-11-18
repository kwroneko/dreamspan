import { Effect } from "effect"
import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SlotOutlet, type Slot } from "../src/slots.tsx"
import { registerPresentation } from "../src/features/chat/registerPresentation.tsx"
import {
  accountSettingSections,
  chatCardActions,
  chatNoteActions,
  chatBranchControls,
  messagePreviews,
  summaryPreviews,
  queuedPreviews,
  chatComposer,
  chatComposerNotes,
  chatColumns,
  chatSettingSections,
  chatSurfaceProviders,
  ChatSurfaceProviders,
  messageVersions,
  summarySettingFields,
  timelineBoundaries,
  timelineRails,
  timelineSummaries,
  useVersionNavigation,
  versionFailureActions
} from "../src/features/chat/presentation.tsx"
import { messageRows, timelineTransforms, type TimelineContext } from "../src/features/chat/timelineContributions.tsx"
import type { ChatView } from "../src/features/chat/session.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

let disposers: Array<() => void>
beforeEach(() => {
  disposers = registerPresentation()
})
afterEach(() => {
  for (const dispose of disposers.reverse()) dispose()
})
const scoped = (install: () => () => void) =>
  Effect.acquireRelease(Effect.sync(install), (dispose) => Effect.sync(dispose))

// Every new outlet actually renders the effective component, rather than merely exposing a registry.
const acceptsAlternative = <P extends object>(slot: Slot<P>) => {
  it(`${slot.id}: scoped replacements, additions and disablement render, then restore defaults`, async () => {
    const original = slot.list()[0]!
    const component: ComponentType<P> = () => createElement("span", null, "synthetic alternative")
    const props = {} as P // Synthetic components need no persisted data.
    const render = () => renderToStaticMarkup(createElement(SlotOutlet<P>, { slot, props }))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          for (const entry of slot.list()) yield* scoped(() => slot.disable(entry.id))
          yield* scoped(() => slot.register({ ...original, component }))
          yield* scoped(() =>
            slot.register({ id: "synthetic.peer", order: -1, component: () => createElement("b", null, "peer") })
          )
          expect(render()).toBe("<b>peer</b><span>synthetic alternative</span>")
          yield* scoped(() => slot.disable(original.id))
          expect(render()).toBe("<b>peer</b>")
        })
      )
    )
    expect(slot.get(original.id)).toBe(original)
    expect(slot.get("synthetic.peer")).toBeUndefined()
  })
}
acceptsAlternative(chatCardActions)
// No built-in note action since notes have no author's note (owner, 2026-11-01): the slot
// starts empty, takes a plugin's action and is empty again once its scope ends.
it(`${chatNoteActions.id}: empty by default, takes a scoped addition, then restores`, async () => {
  type P = Parameters<typeof chatNoteActions.register>[0]["component"] extends ComponentType<infer Q> ? Q : never
  const render = () => renderToStaticMarkup(createElement(SlotOutlet<P>, { slot: chatNoteActions, props: {} as P }))
  expect(chatNoteActions.list()).toEqual([])
  expect(render()).toBe("")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* scoped(() =>
          chatNoteActions.register({
            id: "synthetic.action",
            order: 1,
            component: () => createElement("b", null, "act")
          })
        )
        expect(render()).toBe("<b>act</b>")
      })
    )
  )
  expect(chatNoteActions.list()).toEqual([])
})
acceptsAlternative(chatBranchControls)
acceptsAlternative(messagePreviews)
acceptsAlternative(summaryPreviews)
acceptsAlternative(queuedPreviews)
acceptsAlternative(chatComposer)
acceptsAlternative(chatComposerNotes)
// chat.overlays has no default since a chat's large editors became workbench tabs.
acceptsAlternative(chatColumns)
acceptsAlternative(chatSettingSections)
acceptsAlternative(accountSettingSections)
acceptsAlternative(summarySettingFields)
acceptsAlternative(messageVersions)
acceptsAlternative(timelineBoundaries)
acceptsAlternative(timelineSummaries)
acceptsAlternative(timelineRails)
acceptsAlternative(versionFailureActions)

it("surface providers compose scoped alternatives around the actual children and restore", async () => {
  const original = chatSurfaceProviders.list()
  const props = { children: createElement("p", null, "chat") } as unknown as Parameters<typeof ChatSurfaceProviders>[0]
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const entry of original)
          yield* scoped(() =>
            chatSurfaceProviders.register({
              ...entry,
              component: ({ children }) => createElement("section", { "data-provider": entry.id }, children)
            })
          )
        const html = renderToStaticMarkup(createElement(ChatSurfaceProviders, props))
        expect(html).toBe(
          '<section data-provider="chat.history-preview"><section data-provider="chat.preset-workspace"><section data-provider="chat.portraits"><section data-provider="chat.images"><p>chat</p></section></section></section></section>'
        )
        yield* scoped(() => chatSurfaceProviders.disable("chat.preset-workspace"))
        expect(renderToStaticMarkup(createElement(ChatSurfaceProviders, props))).not.toContain("chat.preset-workspace")
      })
    )
  )
  expect(chatSurfaceProviders.list()).toEqual(original)
})

it("version gestures use the same effective registration as the visible control", async () => {
  const original = messageVersions.get("message.versions")!
  let navigation: ReturnType<typeof useVersionNavigation>
  function Probe() {
    navigation = useVersionNavigation()
    return null
  }
  const read = () => {
    renderToStaticMarkup(createElement(Probe))
    return navigation
  }
  expect(read()).toBe(original)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* scoped(() => messageVersions.register({ id: original.id, order: 10, component: () => null }))
        expect(read()).toBeUndefined()
        yield* scoped(() => messageVersions.disable(original.id))
        expect(read()).toBeUndefined()
      })
    )
  )
  expect(read()).toBe(original)
})

it("timeline transforms insert arbitrary rows, replace built-in projection and restore it", async () => {
  const original = timelineTransforms.get("timeline.lcm")!
  const context = {
    view: { entries: [] } as unknown as ChatView,
    lcm: null,
    summaries: true,
    divider: -1,
    historyDivider: -1
  } satisfies TimelineContext
  const rows = () =>
    [...timelineTransforms.list()]
      .sort((a, b) => a.order - b.order)
      .reduce((rows, entry) => entry.transform(rows, context), messageRows([]))
  expect(rows()).toEqual([])
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* scoped(() =>
          timelineTransforms.register({
            ...original,
            transform: () => [
              {
                key: "synthetic-row",
                estimate: 80,
                from: 1,
                to: 2,
                render: () => createElement("p", null, "synthetic timeline")
              }
            ]
          })
        )
        yield* scoped(() =>
          timelineTransforms.register({
            id: "synthetic.peer",
            order: 30,
            transform: (rows) => rows.map((row) => ({ ...row, estimate: 90 }))
          })
        )
        expect(rows()[0]?.estimate).toBe(90)
        expect(renderToStaticMarkup(createElement(() => rows()[0]!.render({} as never)))).toBe(
          "<p>synthetic timeline</p>"
        )
      })
    )
  )
  expect(rows()).toEqual([])
  expect(timelineTransforms.get(original.id)).toBe(original)
})

it("keeps the LCM divider before a coincident history divider and projects covered messages", () => {
  const entries = [0, 1, 2].map((depth) => ({ depth, slotId: `slot-${depth}` })) as unknown as ChatView["entries"]
  const summary = { id: "synthetic-summary", from: 1, to: 1, lastSlotId: entries[0]!.slotId }
  const view = {
    entries,
    history: { budget: { maximum: 100, target: 80, responseReserve: 20, nonHistoryTokens: 40 } }
  } as unknown as ChatView
  const lcm = { cursorDepth: 0, layer: [summary] } as unknown as NonNullable<ChatView["lcm"]>
  const project = (summaries: boolean) =>
    timelineTransforms
      .list()
      .reduce(
        (rows, entry) => entry.transform(rows, { view, lcm, summaries, divider: 1, historyDivider: 1 }),
        messageRows(entries)
      )
  // Summaries exist and the window starts at the first message: the Messages and Summaries tabs
  // above it (owner, 2026-11-18).
  expect(project(false).map((row) => row.key)).toEqual([
    "lcm-tabs",
    "slot-0",
    "lcm-boundary",
    "history-boundary",
    "slot-1",
    "slot-2"
  ])
  const rows = project(true)
  expect(rows.map((row) => row.key)).toEqual([
    "lcm-tabs",
    "synthetic-summary",
    "lcm-boundary",
    "history-boundary",
    "slot-1",
    "slot-2"
  ])
  expect(rows[1]).toMatchObject({ from: 0, to: 0, lastSlotId: "slot-0" })
})

it("anchors built-in dividers to messages after an earlier plugin inserts a row", () => {
  const entries = [0, 1, 2].map((depth) => ({ depth, slotId: `slot-${depth}` })) as unknown as ChatView["entries"]
  disposers.push(
    timelineTransforms.register({
      id: "synthetic.introduction",
      order: 5,
      transform: (rows) => [{ key: "introduction", estimate: 40, from: -1, to: -1, render: () => null }, ...rows]
    })
  )
  const view = { entries, history: { budget: {} } } as unknown as ChatView
  const lcm = { cursorDepth: 0, layer: [] } as unknown as NonNullable<ChatView["lcm"]>
  const rows = [...timelineTransforms.list()]
    .sort((a, b) => a.order - b.order)
    .reduce(
      (rows, entry) => entry.transform(rows, { view, lcm, summaries: false, divider: 1, historyDivider: 1 }),
      messageRows(entries)
    )
  expect(rows.map((row) => row.key)).toEqual([
    "introduction",
    "slot-0",
    "lcm-boundary",
    "history-boundary",
    "slot-1",
    "slot-2"
  ])
})

it("anchors the LCM divider after a plugin clones message entries", () => {
  const entries = [0, 1, 2].map((depth) => ({ depth, slotId: `slot-${depth}` })) as unknown as ChatView["entries"]
  const view = { entries } as unknown as ChatView
  const lcm = { cursorDepth: 0, layer: [] } as unknown as NonNullable<ChatView["lcm"]>
  const rows = timelineTransforms.get("timeline.lcm")!.transform(
    messageRows(entries).map((row) => ({ ...row, entry: { ...row.entry! } })),
    { view, lcm, summaries: false, divider: 1, historyDivider: -1 }
  )
  expect(rows.map((row) => row.key)).toEqual(["slot-0", "lcm-boundary", "slot-1", "slot-2"])
})

it("the history preview uses its registered body and disappears when History is disabled", async () => {
  const { HistoryPreviewContext } = await import("../src/features/chat/historyPreview.tsx")
  const { chatPanels } = await import("../src/features/chat/panels.tsx")
  const entry = { version: { id: "synthetic-version" } } as unknown as import("@rp/shared/chat.ts").PathEntry
  const session = {
    snapshot: () => ({ cast: null })
  } as unknown as import("../src/features/chat/session.ts").ChatSession
  const hit = {
    kind: "version_replace",
    beforeId: "synthetic-version",
    before: "A synthetic sentence",
    matches: [{ start: 2, end: 11, replacement: "replacement" }]
  } as unknown as import("@rp/shared/historyApi.ts").HistoryHit
  const render = () =>
    renderToStaticMarkup(
      createElement(
        HistoryPreviewContext,
        { value: { hits: [hit], active: true, publish: () => undefined } },
        createElement(SlotOutlet<{ entry: typeof entry; session: typeof session }>, {
          slot: messagePreviews,
          props: { entry, session }
        })
      )
    )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* scoped(() =>
          chatPanels.register({ id: "history", label: "History", order: 10, icon: "edit", component: () => null })
        )
        expect(render()).toContain("Replacement preview")
        yield* scoped(() => chatPanels.disable("history"))
        expect(render()).toBe("")
      })
    )
  )
})

it("summary previews retain skipped matches across tabs and reject obsolete revisions or a disabled History panel", async () => {
  const { HistoryPreviewContext } = await import("../src/features/chat/historyPreview.tsx")
  const { chatPanels } = await import("../src/features/chat/panels.tsx")
  const session = {
    snapshot: () => ({ cast: null })
  } as unknown as import("../src/features/chat/session.ts").ChatSession
  const summary = { id: "summary", revisionId: "revision" } as unknown as import("@rp/shared/lcm.ts").LcmSummary
  const hit = {
    kind: "summary_revision",
    targetId: "summary",
    beforeId: "revision",
    before: "bridge and bridge",
    matches: [{ start: 11, end: 17, replacement: "pier" }]
  } as unknown as import("@rp/shared/historyApi.ts").HistoryHit
  const render = (revisionId = "revision") =>
    renderToStaticMarkup(
      createElement(
        HistoryPreviewContext,
        { value: { hits: [hit], active: false, publish: () => undefined } },
        createElement(SlotOutlet<{ summary: typeof summary; session: typeof session }>, {
          slot: summaryPreviews,
          props: { session, summary: { ...summary, revisionId: revisionId as typeof summary.revisionId } }
        })
      )
    )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* scoped(() =>
          chatPanels.register({ id: "history", label: "History", order: 10, icon: "edit", component: () => null })
        )
        expect(render()).toContain("bridge and <mark")
        expect(render()).toContain('<ins class="text-accent">pier</ins>')
        expect(render("new-revision")).toBe("")
        yield* scoped(() => chatPanels.disable("history"))
        expect(render()).toBe("")
      })
    )
  )
})
