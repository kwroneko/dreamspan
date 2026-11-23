// Typing into a long draft in the composer, at the bottom of the long fixture chat: 200 characters
// at the end of a 20,000 character draft of dialogue, italics and bold, which the composer shows as
// the message will render (Composer.tsx, the `message.text-editor` box). Each keystroke is
// measured from its key event to the frame after its paint, with the page's script time per
// keystroke and the styling's own share of it (a CPU profile's samples in the editor styling's
// chunk). The scenario only types into `composer` and reads the draft over RPC, so it runs as it
// is against a build whose composer is a plain textarea, for the comparison.
import { appendFileSync, rmSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { budgets } from "./budgets.ts"
import { type Fixture, prepare } from "./fixtures.ts"
import { type PerfServer, startServer, withClient } from "./support.ts"

let server: PerfServer
let fixture: Fixture
let dataDir: string
test.beforeAll(async () => {
  const prepared = await prepare()
  fixture = prepared.fixture
  dataDir = prepared.dataDir
  server = await startServer(dataDir)
})
test.afterAll(async () => {
  await server?.stop()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

const record = (scenario: string, values: Record<string, number | string>) => {
  const line = JSON.stringify({ scenario, ...values, loadAverage: loadavg()[0]!.toFixed(1) })
  appendFileSync(join(test.info().project.outputDir, "perf-results.jsonl"), `${line}\n`)
  console.log(line)
}

/** About 900 characters of narration and dialogue: italics, bold, underline and quotes. */
const paragraph = (n: number) =>
  [
    `*The lantern ${n} swings over the harbor, and the rope by the quay creaks as the boats knock together.*`,
    `"You came back," she says, not looking up from the ledger. "I always do," he answers, **quietly**,`,
    `and sets the wet coil of rope down by the door. The fog has come in over the __grey stones__ again;`,
    `nobody on the pier looks up, and the gulls are quiet for once. *She turns a page.* "Paragraph ${n},"`,
    `she reads aloud, "the tide at four, the wind from the west, a skiff seen and lost by the point."`,
    `He laughs at that, and the lamp gutters, and for a while neither of them says anything at all,`,
    `listening to the water under the boards and the bell on the far buoy ringing twice, then again.`
  ].join(" ")
const DRAFT = (() => {
  const parts: string[] = []
  for (let n = 1; parts.join("\n\n").length < 20_000; n++) parts.push(paragraph(n))
  return parts.join("\n\n")
})()
/** 200 characters: dialogue, italics and bold among narration. */
const TYPED = (() => {
  const unit = ` She says "hello there," and *smiles* at **him**. "Again?"`
  let text = ""
  while (text.length < 200) text += unit
  return text.slice(0, 200)
})()

test("typing 200 characters into a 20,000 character composer draft, in the long chat", async ({ page }) => {
  test.setTimeout(10 * 60_000)
  expect(DRAFT.length).toBeGreaterThanOrEqual(20_000)
  expect(TYPED.length).toBe(200)
  const chatId: ChatId = fixture.long.chatId
  // The draft, saved as the client saves typing.
  await withClient(server, (api) =>
    Effect.gen(function* () {
      const draft = yield* api.OpenComposer({ chatId, forkId: null })
      yield* api.SetComposerChoice({ chatId, draftId: draft.id, guidance: false })
      yield* api.SaveComposer({
        next: false,
        operationId: crypto.randomUUID(),
        chatId,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        content: DRAFT
      })
    })
  )
  // Each keystroke: from its event to the task after the frame that painted it.
  await page.addInitScript(() => {
    const w = window as unknown as { __keys: Array<number> }
    w.__keys = []
    addEventListener(
      "keydown",
      (event) => {
        const start = event.timeStamp
        requestAnimationFrame(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => w.__keys.push(performance.now() - start)
          channel.port2.postMessage(null)
        })
      },
      true
    )
  })
  const opened = Date.now()
  await page.goto(`${server.url}/chats/${chatId}`)
  const box = page.getByTestId("composer")
  // A textarea's value, or the editor's whole text (lines out of view included).
  const value = () =>
    box.evaluate((element) =>
      element instanceof HTMLTextAreaElement
        ? element.value
        : (
            element as HTMLElement & { cmTile: { root: { view: { state: { doc: { toString: () => string } } } } } }
          ).cmTile.root.view.state.doc.toString()
    )
  await expect.poll(value).toBe(DRAFT)
  const openMs = Date.now() - opened
  const styled = (await page.getByTestId("composer-box").locator(".rp-md-quote").count()) > 0
  await box.click()
  await box.press("ControlOrMeta+End")
  await page.waitForTimeout(1500)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 })
  const metric = async (name: string) =>
    (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === name)!.value
  await page.evaluate(() => void ((window as unknown as { __keys: Array<number> }).__keys.length = 0))
  const scriptBefore = await metric("ScriptDuration")
  const taskBefore = await metric("TaskDuration")
  await cdp.send("Profiler.start")
  await page.keyboard.type(TYPED, { delay: 60 })
  await page.waitForTimeout(500)
  const { profile } = await cdp.send("Profiler.stop")
  const scriptMs = ((await metric("ScriptDuration")) - scriptBefore) * 1000
  const taskMs = ((await metric("TaskDuration")) - taskBefore) * 1000
  const keys = await page.evaluate(() => (window as unknown as { __keys: Array<number> }).__keys)

  // The styling's own samples: those with a function of the chunk holding the editor's styling
  // (MessageTextSurface) on their stack, so what it calls (a parse, CodeMirror) counts too.
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const styling = new Set(
    profile.nodes.filter((node) => node.callFrame.url.includes("MessageTextSurface")).map((node) => node.id)
  )
  const inStyling = (id: number) => {
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) if (styling.has(at)) return true
    return false
  }
  const deltas = profile.timeDeltas ?? []
  let stylingUs = 0
  profile.samples?.forEach((id, i) => {
    if (inStyling(id)) stylingUs += deltas[i + 1] ?? deltas[i] ?? 0
  })

  // Every keystroke reached the draft on the server, exactly.
  await expect
    .poll(
      async () =>
        (await withClient(server, (api) => api.OpenComposer({ chatId, forkId: null }))).content === DRAFT + TYPED,
      { timeout: 30_000 }
    )
    .toBe(true)
  if (styled) {
    await expect(
      page.getByTestId("composer-box").locator(".rp-md-quote").filter({ hasText: '"Again?"' })
    ).not.toHaveCount(0)
  }

  const sorted = [...keys].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const values = {
    styled: styled ? "yes" : "no",
    draftChars: DRAFT.length,
    keystrokes: TYPED.length,
    openMs,
    keyToPaintP50Ms: Math.round(at(0.5) * 10) / 10,
    keyToPaintP95Ms: Math.round(at(0.95) * 10) / 10,
    keyToPaintMaxMs: Math.round(sorted.at(-1)! * 10) / 10,
    scriptMsPerKey: Math.round((scriptMs / TYPED.length) * 100) / 100,
    taskMsPerKey: Math.round((taskMs / TYPED.length) * 100) / 100,
    stylingMsPerKey: Math.round((stylingUs / 1000 / TYPED.length) * 100) / 100
  }
  record("composer-style-typing", values)
  expect(keys.length).toBe(TYPED.length)
  expect(values.stylingMsPerKey).toBeLessThanOrEqual(budgets.composerStylingMsPerKey)
  expect(values.scriptMsPerKey).toBeLessThanOrEqual(budgets.composerScriptMsPerKey)
  expect(values.keyToPaintP95Ms).toBeLessThanOrEqual(budgets.composerKeyToPaintP95Ms)
  // Leave the fixture's composer as it was for the scenarios after this one.
  await withClient(server, (api) =>
    Effect.gen(function* () {
      const draft = yield* api.OpenComposer({ chatId, forkId: null })
      yield* api.SaveComposer({
        next: false,
        operationId: crypto.randomUUID(),
        chatId,
        draftId: draft.id,
        rowVersion: draft.rowVersion,
        session: draft.session,
        content: ""
      })
    })
  )
})
