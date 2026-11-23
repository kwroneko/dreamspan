// Typing into a long message being edited, at the bottom of the long fixture chat: a 20,000
// character message in long paragraphs of dialogue, italics and bold, styled as it renders
// (ui/MessageTextEditor.tsx). Each keystroke is measured from its key event to the frame after
// its paint, with the page's script time per keystroke, and the styling's own share of it (a
// CPU profile's samples in the editor styling's code). The styling parses nothing on the page
// while typing: its worker does.
import { appendFileSync, rmSync } from "node:fs"
import { loadavg } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
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

const record = (scenario: string, values: Record<string, number>) => {
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
const MESSAGE = (() => {
  const parts: string[] = []
  for (let n = 1; parts.join("\n\n").length < 20_000; n++) parts.push(paragraph(n))
  return parts.join("\n\n")
})()
const TYPED = ` She says "hello there," and *smiles* at **him**. "Again?"`

test("typing into a 20,000 character message being edited, in the long chat", async ({ page }) => {
  expect(MESSAGE.length).toBeGreaterThanOrEqual(20_000)
  const chatId: ChatId = fixture.long.chatId
  const slot = await withClient(server, (api) =>
    Effect.gen(function* () {
      const window = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      const sent = yield* api.SendMessage({
        chatId,
        parentSlotId: window.entries.at(-1)!.slotId,
        branch: false,
        content: MESSAGE,
        reply: false
      })
      if (sent._tag !== "Posted") return yield* Effect.die(new Error("the message was queued"))
      return sent.entry.slotId as SlotId
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
  await page.goto(`${server.url}/chats/${chatId}`)
  const row = page.locator(`article[data-slot="${slot}"]`)
  const body = row.locator(".markdown")
  await expect(body).toContainText("Paragraph 12,")
  // The middle of the message: a double-click on a word in its twelfth paragraph.
  const opened = Date.now()
  await body
    .getByText(/Paragraph 12,/)
    .first()
    .evaluate((element) => element.scrollIntoView({ block: "center" }))
  await body.locator("q").filter({ hasText: "Paragraph 12," }).dblclick()
  const editor = row.getByRole("textbox", { name: "Message text" })
  await expect(editor).toBeFocused()
  await expect(row.locator(".rp-md-quote").first()).toBeVisible()
  const openMs = Date.now() - opened
  // The caret at the end of that paragraph, in narration: what's typed is a sentence of its own.
  const end = MESSAGE.indexOf("then again.", MESSAGE.indexOf("Paragraph 12,")) + "then again.".length
  await editor.evaluate((element, anchor) => {
    const view = (
      element as HTMLElement & {
        cmTile: { root: { view: { dispatch: (spec: { selection: { anchor: number } }) => void } } }
      }
    ).cmTile.root.view
    view.dispatch({ selection: { anchor } })
  }, end)
  await page.waitForTimeout(1000)

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

  // Every keystroke landed, and what was typed is styled as it will render.
  await expect.poll(async () => (await editor.evaluate((e) => e.textContent ?? "")).includes("hello there")).toBe(true)
  await expect(row.locator(".rp-md-quote").filter({ hasText: '"hello there,"' })).toHaveCount(1)
  await expect(row.locator(".rp-md-em").filter({ hasText: "*smiles*" })).toHaveCount(1)

  const sorted = [...keys].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const values = {
    messageChars: MESSAGE.length,
    keystrokes: TYPED.length,
    openMs,
    keyToPaintP50Ms: Math.round(at(0.5) * 10) / 10,
    keyToPaintP95Ms: Math.round(at(0.95) * 10) / 10,
    keyToPaintMaxMs: Math.round(sorted.at(-1)! * 10) / 10,
    scriptMsPerKey: Math.round((scriptMs / TYPED.length) * 100) / 100,
    taskMsPerKey: Math.round((taskMs / TYPED.length) * 100) / 100,
    stylingMsPerKey: Math.round((stylingUs / 1000 / TYPED.length) * 100) / 100
  }
  record("edit-style-typing", values)
  expect(keys.length).toBe(TYPED.length)
  expect(values.stylingMsPerKey).toBeLessThanOrEqual(budgets.editStylingMsPerKey)
  expect(values.scriptMsPerKey).toBeLessThanOrEqual(budgets.editScriptMsPerKey)
  expect(values.keyToPaintP95Ms).toBeLessThanOrEqual(budgets.editKeyToPaintP95Ms)
  await row.getByRole("button", { name: "Cancel" }).click()
})
