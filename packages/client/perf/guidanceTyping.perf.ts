// Typing guidance for a new version in a long chat (owner, 2026-11-21: the space between the last
// message and the composer appeared and disappeared while typing, after a reload with the bar
// open). Every frame while typing, before and after the reload, the composer and the last
// message stay where they are, at the bottom of the long fixture chat at 1440 px.
import { rmSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import { type Fixture, prepare } from "./fixtures.ts"
import { type PerfServer, startServer } from "./support.ts"

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

const box = (page: Page) => page.getByTestId("composer")
const bar = (page: Page) => page.getByTestId("guidance-edit-bar")

/** Samples every frame until `stop`: the composer box, the last message and the gap between them. */
const startSampling = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { frames_: Array<string>; stop_: boolean }
    w.frames_ = []
    w.stop_ = false
    const tick = () => {
      const composer = document.querySelector('[data-testid="composer"]')!.getBoundingClientRect()
      const list = document.querySelector('[data-testid="messages"]')!
      const rows = [...document.querySelectorAll("article[data-slot]")]
      const last = rows.reduce<Element | null>(
        (a, r) => (a === null || r.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? r : a),
        null
      )!
      const message = last.getBoundingClientRect()
      w.frames_.push(
        [composer.y, composer.height, message.bottom, list.scrollHeight - list.scrollTop - list.clientHeight]
          .map(Math.round)
          .join(",")
      )
      if (!w.stop_) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
const stopSampling = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { frames_: Array<string>; stop_: boolean }
    w.stop_ = true
    return w.frames_
  })

const typeAndSample = async (page: Page, text: string) => {
  await page.waitForTimeout(1500)
  await startSampling(page)
  await box(page).pressSequentially(text, { delay: 90 })
  await page.waitForTimeout(1500)
  const frames = await stopSampling(page)
  return [...new Set(frames)]
}

test("typing guidance for a new version keeps the last message and the composer still, before and after a reload", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${server.url}/chats/${fixture.long.chatId}`)
  const replies = page.locator("article[data-slot]").filter({ has: page.getByRole("button", { name: "More actions" }) })
  await expect(replies.last()).toBeVisible()
  // The last model reply's menu: New version with guidance….
  const rows = page.locator("article[data-slot]")
  let opened = false
  for (let i = (await rows.count()) - 1; i >= 0 && !opened; i--) {
    const row = rows.nth(i)
    await row.hover()
    await row.getByRole("button", { name: "More actions" }).click()
    const item = page.getByRole("menuitem", { name: "New swipe with guidance…" })
    if ((await item.count()) > 0) {
      await item.click()
      opened = true
    } else await page.keyboard.press("Escape")
  }
  expect(opened).toBe(true)
  await expect(bar(page)).toBeVisible()
  await box(page).click()
  await box(page).press("End")
  const before = await typeAndSample(page, "Rain on the dock")
  console.log(JSON.stringify({ before }))
  await page.reload()
  await expect(bar(page)).toBeVisible()
  await box(page).click()
  await box(page).press("End")
  const after = await typeAndSample(page, ", and fog")
  console.log(JSON.stringify({ after }))
  expect(before).toHaveLength(1)
  expect(after).toHaveLength(1)
})
