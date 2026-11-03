// Rounds of replies (owner, 2026-11-02; DESIGN §2.3): after a send, everyone the chat's reply
// order activates replies in turn, as ST's group chats do, the Next chip naming the whole round
// first; Stop ends the reply and holds the rest, which Continue round goes on with (or End round
// drops); the Cast tab's "One reply at a time" limits it to one reply a send. Every card here is
// made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { closePanel, openPanel } from "./support/panel.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextChip } from "./support/strip.ts"

// About four seconds a reply: time to see the round under way and to stop one.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "20", FAKE_GENERATOR_TOKENS: "80" })
let adminCookie: string
test.beforeAll(async () => {
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), adminCookie, use)

/** Mira and Wren always pass the roll, Tobin never: natural order's round is Mira and Wren, shuffled. */
const TALKATIVENESS: Record<string, number> = { Mira: 1, Wren: 1, Tobin: 0 }
const importCard = async (name: string, talkativeness: number) => {
  const response = await fetch(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    method: "POST",
    headers: { origin: server().url, cookie: adminCookie, "content-type": "application/octet-stream" },
    body: JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name, extensions: { talkativeness } } })
  })
  expect(response.status).toBe(200)
}

/** A group chat with Mira, Tobin and Wren, played as Ana, with no messages yet. */
const groupChat = async (title: string) => {
  const known = await admin((api) => api.ListCards())
  for (const [name, talkativeness] of Object.entries(TALKATIVENESS))
    if (!known.some((card) => card.name === name)) await importCard(name, talkativeness)
  return admin((api) =>
    Effect.gen(function* () {
      const ids: Record<string, EntityId> = {}
      for (const name of ["Mira", "Tobin", "Wren", "Ana"]) {
        const existing = (yield* api.ListCards()).find((card) => card.name === name)
        ids[name] = existing?.entityId ?? (yield* api.CreateCard({ label: name, name })).entityId
      }
      yield* api.SetPersona({ entityId: ids.Ana!, persona: true })
      const chat = yield* api.CreateChat({ title })
      for (const name of ["Mira", "Tobin", "Wren", "Ana"])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ids[name]! } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [ids.Ana!] } })
      return chat.id
    })
  )
}

const composer = (page: Page) => page.getByLabel("Message", { exact: true })
const generating = (page: Page) => page.getByText("generating", { exact: true })
const messages = (page: Page) => page.locator("article[data-slot]")
const header = (page: Page, index: number) => messages(page).nth(index).locator("header").first()
const round = (page: Page) => page.getByRole("group", { name: "This round", exact: true })

/** The round the Next chip plans, in turn: "Next: Wren, Mira. …" → ["Wren", "Mira"]. */
const plannedRound = async (page: Page) => {
  await expect(nextChip(page)).toHaveAccessibleName(/^Next: (Mira, Wren|Wren, Mira)\. Choose who replies next$/)
  const name = (await nextChip(page).getAttribute("aria-label"))!
  return name.slice("Next: ".length, name.indexOf(".")).split(", ")
}

test("a send's whole round replies in turn, in the order the Next chip showed", async ({ page }) => {
  const chatId = await groupChat("Round")
  await page.goto(`${server().url}/chats/${chatId}`)
  const [first, second] = await plannedRound(page)
  await composer(page).fill("The lantern gutters.")
  await page.keyboard.press("Enter")
  await expect(header(page, 1)).toContainText(first!)
  // While the first is written, the round says who's next.
  await expect(round(page)).toContainText(`Then ${second}, in turn`)
  await expect(messages(page)).toHaveCount(3, { timeout: 30_000 })
  await expect(header(page, 2)).toContainText(second!)
  await expect(generating(page)).toHaveCount(0, { timeout: 30_000 })
  await expect(round(page)).toHaveCount(0)
  // Tobin never passes his roll, so the round was those two.
  await expect(messages(page)).toHaveCount(3)
})

test("Stop ends the reply and holds the round; Continue round goes on, End round drops it", async ({ page }) => {
  const chatId = await groupChat("Stopped round")
  await page.goto(`${server().url}/chats/${chatId}`)
  const [first, second] = await plannedRound(page)
  await composer(page).fill("Who's there?")
  await page.keyboard.press("Enter")
  await expect(header(page, 1)).toContainText(first!)
  await expect(generating(page)).toHaveCount(1)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(round(page)).toContainText("round stopped")
  await expect(round(page)).toContainText(`Still to reply: ${second}`)
  // Nothing more is written meanwhile, and a reload (or another tab) shows the same.
  await page.waitForTimeout(500)
  await expect(messages(page)).toHaveCount(2)
  await page.reload()
  await expect(round(page)).toContainText(`Still to reply: ${second}`)
  await round(page).getByRole("button", { name: "Continue round", exact: true }).click()
  await expect(messages(page)).toHaveCount(3)
  await expect(header(page, 2)).toContainText(second!)
  await expect(round(page)).toHaveCount(0)
  await expect(generating(page)).toHaveCount(0, { timeout: 30_000 })

  // Stopped again, End round drops the rest: no one else replies.
  // The text being sent plans the round: typed, the last to speak may reply again.
  await composer(page).fill("Again.")
  const [next] = await plannedRound(page)
  await page.keyboard.press("Enter")
  await expect(header(page, 4)).toContainText(next!)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(round(page)).toContainText("round stopped")
  await round(page).getByRole("button", { name: "End round", exact: true }).click()
  await expect(round(page)).toHaveCount(0)
  await page.waitForTimeout(500)
  await expect(messages(page)).toHaveCount(5)
})

test("One reply at a time, in the Cast tab: a send gets one reply, and no round follows", async ({ page }) => {
  const chatId = await groupChat("One at a time")
  await page.goto(`${server().url}/chats/${chatId}`)
  await plannedRound(page)
  const cast = await openPanel(page, "Cast")
  const toggle = cast.getByRole("switch", { name: "One reply at a time" })
  // Off by default, as ST's groups reply.
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(nextChip(page)).toHaveAccessibleName(/^Next: (Mira|Wren)\. Choose who replies next$/)
  await page.reload()
  await expect(nextChip(page)).toHaveAccessibleName(/^Next: (Mira|Wren)\. Choose who replies next$/)
  await composer(page).fill("Just one of you.")
  await page.keyboard.press("Enter")
  await expect(messages(page)).toHaveCount(2)
  await expect(round(page)).toHaveCount(0)
  await expect(generating(page)).toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(500)
  await expect(messages(page)).toHaveCount(2)
})

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`round controls and Cast stay usable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const chatId = await groupChat(`Round ${width} ${theme}`)
      const shoot = async (state: string) => {
        const dir = process.env.RP_SCREENS
        if (!dir) return
        mkdirSync(dir, { recursive: true })
        await page.screenshot({ path: join(dir, `${width}-${theme}-${state}.png`), animations: "disabled" })
      }
      await page.goto(`${server().url}/chats/${chatId}`)
      await plannedRound(page)
      await shoot("next")
      const cast = await openPanel(page, "Cast")
      await expect(cast.getByRole("switch", { name: "One reply at a time" })).toBeVisible()
      await shoot("cast")
      await closePanel(page)
      await composer(page).fill("Mira Wren, answer me.")
      await page.keyboard.press("Enter")
      await expect(round(page)).toBeVisible()
      await shoot("running")
      await page.getByRole("button", { name: "Stop", exact: true }).click()
      await expect(round(page)).toContainText("round stopped")
      await expect(round(page).getByRole("button", { name: "Continue round", exact: true })).toBeInViewport()
      await expect(round(page).getByRole("button", { name: "End round", exact: true })).toBeInViewport()
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
      await shoot("stopped")
      await round(page).getByRole("button", { name: "End round", exact: true }).click()
    })
  }
}

test("ending a held round with a new message removes its controls in both tabs", async ({ page, context }) => {
  const chatId = await groupChat("Round in two tabs")
  await page.goto(`${server().url}/chats/${chatId}`)
  await plannedRound(page)
  await composer(page).fill("Mira Wren, come here.")
  await page.keyboard.press("Enter")
  await expect(round(page)).toBeVisible()
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(round(page)).toContainText("round stopped")
  const other = await context.newPage()
  await other.goto(`${server().url}/chats/${chatId}`)
  await expect(round(other)).toContainText("round stopped")
  await admin((api) =>
    Effect.gen(function* () {
      const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      yield* api.SendMessage({
        chatId,
        parentSlotId: path.entries.at(-1)!.slotId,
        branch: false,
        content: "Only a message",
        reply: false
      })
    })
  )
  await expect(round(page)).toHaveCount(0)
  await expect(round(other)).toHaveCount(0)
})

for (const width of [1440, 1024, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`reply settings wrap to the available panel width at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const chatId = await groupChat(`Reply layout ${width} ${theme}`)
      await page.goto(`${server().url}/chats/${chatId}`)
      const cast = await openPanel(page, "Cast")
      // Panels are resizable: exercise room for both controls, rather than a viewport breakpoint.
      if (width === 1440) await page.getByRole("separator", { name: "Resize chat panel" }).press("End")
      const select = cast.getByRole("combobox", { name: "Who replies", exact: true })
      const toggle = cast.getByRole("switch", { name: "One reply at a time" })
      await expect(select).toBeVisible()
      await expect(toggle).toBeVisible()
      const picker = (await select.boundingBox())!
      const switchBox = (await toggle.boundingBox())!
      if (width === 1440) {
        expect(switchBox.x).toBeGreaterThanOrEqual(picker.x + picker.width + 16)
        expect(Math.abs(switchBox.y + switchBox.height / 2 - picker.y - picker.height / 2)).toBeLessThan(1)
      } else {
        expect(switchBox.y).toBeGreaterThanOrEqual(picker.y + picker.height + 8)
        expect(Math.abs(switchBox.x - picker.x)).toBeLessThan(1)
      }
      if (process.env.RP_SCREENS) {
        mkdirSync(process.env.RP_SCREENS, { recursive: true })
        await cast.getByRole("region", { name: "Who replies", exact: true }).screenshot({
          path: join(process.env.RP_SCREENS, `${width}-${theme}-reply-settings.png`)
        })
      }
    })
  }
}
