// A card's header at the top of its tab in the chat's panel and of the full editor
// (CardNameHeader.tsx `CardHeader`, DESIGN §4, owner 2026-11-02): the portrait as tall as the
// names beside it, top and bottom aligned; "You play" a badge on the portrait, so a persona's
// header has the same shape as any character's; Adjust cutout and View full image over the
// picture, reachable by keyboard. Screenshots of each case at the panel's minimum, default
// and a wide width, on a phone, light and dark. Every card here is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { portraitPng } from "./support/portrait.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(240_000)

const shots = process.env.SCREENSHOT_DIR
const shoot = async (target: Page | Locator, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await target.screenshot({ path: join(shots, `${name}.png`) })
}

const PERSONA = "Shannon"
const PLAIN = "Wren"
const NAMED = "Mio"
const LONG = "Seraphina Valentina Montgomery-Blackwood of the Silver Marches"
const CARDS: ReadonlyArray<{ name: string; data?: Record<string, unknown>; image?: boolean }> = [
  { name: PERSONA, image: true },
  { name: PLAIN },
  { name: NAMED, data: { character_version: "Winter 2.1", nickname: "Mio-chan" }, image: true },
  {
    name: LONG,
    data: {
      character_version: "Extended edition with the northern chapters",
      nickname: "Lady Seraphina of the Marches"
    }
  }
]

let chat = ""
let ids: Record<string, EntityId> = {}
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  for (const card of CARDS) {
    const data = {
      name: card.name,
      description: `${card.name} keeps the lighthouse.`,
      first_mes: "Hello.",
      ...card.data
    }
    const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
      data: Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data })),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.status()).toBe(200)
  }
  const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
  ids = Object.fromEntries(
    CARDS.map(({ name }) => [name, refs.find((ref) => ref.label === name)!.entityId as EntityId])
  )
  // A wide picture (900 × 600), shown by its default cutout.
  for (const card of CARDS.filter((card) => card.image)) {
    await page.goto(`${server().url}/library/${refs.find((ref) => ref.label === card.name)!.id}`)
    await cardFieldsTab(page, "Metadata")
    await page
      .getByLabel("Choose an avatar, or drop it here")
      .setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: portraitPng() })
    await page
      .getByRole("dialog", { name: /new picture$/ })
      .getByRole("button", { name: "Save picture" })
      .click()
    await expect(page.getByRole("img", { name: "The card's avatar" })).toBeVisible()
  }
  await page.close()
  await admin((api) => api.SetPersona({ entityId: ids[PERSONA]!, persona: true }))
  const started = await admin((api) =>
    api.StartChat({
      cards: [ids[PLAIN]!, ids[NAMED]!, ids[LONG]!],
      persona: ids[PERSONA]!,
      greeting: null,
      first: { _tag: "Send", content: "Is anyone here?", speakerEntityId: null }
    })
  )
  chat = started.chat.id
})

const box = async (locator: Locator) => (await locator.boundingBox())!

/** The header's geometry: the portrait's box, and the first and last rows beside it. */
const measure = async (panel: Locator) => {
  const header = panel.locator("[data-card-header]")
  await expect(header).toBeVisible()
  const portrait = await box(header.locator("[data-card-header-portrait]"))
  const rows = header.locator("[data-card-header-row]")
  const first = await box(rows.first())
  const last = await box(rows.last())
  return { header: await box(header), portrait, first, last }
}

const open = async (page: Page, name: string) => {
  await page.goto(`${server().url}/chats/${chat}?panel=card:${ids[name]}`)
  const panel = page.getByRole("tabpanel", { name, exact: true })
  await expect(panel.locator("[data-card-tokens]")).toBeVisible({ timeout: 30_000 })
  return panel
}

const WIDTHS = { min: "Home", default: null, wide: "End" } as const

for (const scheme of ["light", "dark"] as const)
  for (const [mode, key] of [...Object.entries(WIDTHS), ["phone", null] as const])
    test(`the header's shape, ${mode} width, ${scheme}`, async ({ page }) => {
      const phone = mode === "phone"
      await page.setViewportSize({ width: phone ? 390 : 1440, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const heights: number[] = []
      for (const name of [PERSONA, PLAIN, NAMED, LONG]) {
        const panel = await open(page, name)
        if (!phone) {
          const handle = page.getByRole("separator", { name: "Resize chat panel" })
          // A double-click resets it to the default; Home and End are its narrowest and widest.
          await handle.dispatchEvent("dblclick")
          if (key) await handle.press(key)
        }
        await page.mouse.move(0, 0)
        await page.waitForTimeout(300)
        const header = panel.locator("[data-card-header]")
        const slug = name.split(" ")[0]!.toLowerCase()
        await shoot(phone ? page : page.getByRole("complementary", { name: "Chat panel" }), `${mode}-${scheme}-${slug}`)
        // The portrait's top and bottom are the names' top and bottom, whatever the names.
        const { header: whole, portrait, first, last } = await measure(panel)
        expect.soft(Math.abs(portrait.y - first.y), `${name}: top`).toBeLessThanOrEqual(1)
        expect
          .soft(Math.abs(portrait.y + portrait.height - (last.y + last.height)), `${name}: bottom`)
          .toBeLessThanOrEqual(1)
        expect.soft(Math.abs(whole.height - portrait.height), `${name}: header height`).toBeLessThanOrEqual(1)
        heights.push(whole.height)
        // "You play" is on the persona's portrait, and only there.
        const badge = header.locator("[data-card-header-portrait]").getByText("You play", { exact: true })
        await expect.soft(badge).toHaveCount(name === PERSONA ? 1 : 0)
        // Every pencil on one vertical line.
        const pencils = await header
          .getByRole("button", { name: /^Rename / })
          .evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().left)))
        expect.soft(pencils.length, `${name}: pencils`).toBe(3)
        expect.soft(new Set(pencils).size, `${name}: one pencil axis ${pencils.join(",")}`).toBe(1)
      }
      // A persona's header is the same shape as a character's.
      expect.soft(Math.max(...heights) - Math.min(...heights), `heights ${heights.join(",")}`).toBeLessThanOrEqual(1)
    })

test("the picture's controls are over it, and reached by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const panel = await open(page, NAMED)
  const portrait = panel.locator("[data-card-header-portrait]")
  const area = await box(portrait)
  const change = panel.getByRole("button", { name: `Change ${NAMED}'s picture`, exact: true })
  for (const name of ["Adjust cutout", "View full image"]) {
    const control = panel.getByRole("button", { name, exact: true })
    const at = await box(control)
    // On the picture, not under it.
    expect(at.y).toBeGreaterThanOrEqual(area.y)
    expect(at.y + at.height).toBeLessThanOrEqual(area.y + area.height + 0.5)
    expect(at.x + at.width).toBeLessThanOrEqual(area.x + area.width + 0.5)
  }
  // Faint until the picture is hovered or a control has the keyboard's focus.
  const adjust = panel.getByRole("button", { name: "Adjust cutout", exact: true })
  const opacity = (locator: Locator) =>
    locator.evaluate((element) => Number(getComputedStyle(element.closest("[data-portrait-controls]")!).opacity))
  await page.mouse.move(0, 0)
  await expect.poll(() => opacity(adjust)).toBeLessThan(1)
  await change.focus()
  await page.keyboard.press("Tab")
  await expect(adjust).toBeFocused()
  await expect.poll(() => opacity(adjust)).toBe(1)
  await page.keyboard.press("Tab")
  await expect(panel.getByRole("button", { name: "View full image", exact: true })).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Shift+Tab")
  await expect(change).toBeFocused()
  await change.hover()
  await expect.poll(() => opacity(adjust)).toBe(1)
  // Each keeps its explanation.
  await adjust.hover()
  await expect(page.getByText("Adjust cutout: which part of the picture small portraits show")).toBeVisible()
})

test("the full editor's header is the same", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
      for (const name of [NAMED, LONG]) {
        await page.goto(`${server().url}/library/${refs.find((ref) => ref.label === name)!.id}`)
        await expect(page.locator("[data-card-tokens]")).toBeVisible({ timeout: 30_000 })
        await page.mouse.move(0, 0)
        await page.waitForTimeout(300)
        await shoot(page, `editor-${width}-${scheme}-${name.split(" ")[0]!.toLowerCase()}`)
        const { portrait, first, last } = await measure(page.locator("main"))
        expect.soft(Math.abs(portrait.y - first.y), `${name}: top`).toBeLessThanOrEqual(1)
        expect
          .soft(Math.abs(portrait.y + portrait.height - (last.y + last.height)), `${name}: bottom`)
          .toBeLessThanOrEqual(1)
      }
    }
})
