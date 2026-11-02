// A card's header at the top of its tab in the chat's panel and of the full editor
// (CardNameHeader.tsx `CardHeader`, DESIGN §4, owner 2026-11-02): the portrait as tall as the
// names beside it, stacked from the top; "You" a badge on the portrait, so a persona's
// header has the same shape as any character's; one Picture button over the picture's
// lower-right corner, reachable by keyboard. Screenshots of each case at the panel's minimum, default
// and a wide width, on a phone, light and dark. Every card here is made up.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { DISPLAY_HINT, NICKNAME_HINT } from "../src/features/editor/cardNameHints.ts"
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
const LONG =
  "Seraphina Valentina Montgomery-Blackwood of the Silver Marches, keeper of the northern lighthouse and envoy of the winter court beyond the mountains and the never-ending eastern sea"
const CARDS: ReadonlyArray<{ name: string; data?: Record<string, unknown>; image?: boolean }> = [
  { name: PERSONA, image: true },
  { name: PLAIN },
  {
    name: NAMED,
    data: { character_version: "Winter 2.1", nickname: "Mio-chan", tags: ["lighthouse", "coast", "slow burn"] },
    image: true
  },
  {
    name: LONG,
    data: {
      character_version:
        "Extended edition with the northern chapters and the winter court, annotated by the lighthouse keepers. ".repeat(
          3
        ),
      nickname:
        "Lady Seraphina of the Marches, keeper of the northern lighthouse and envoy of the winter court beyond the mountains and the never-ending eastern sea"
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

/** Check visible text fragments, so a two-line heading cannot leave its pencil on line one. */
const expectInlineNames = async (scope: Locator) => {
  const header = scope.locator("[data-card-header]")
  const geometry = await header.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>("[data-card-header-row]")].slice(0, 3).map((text) => {
      const area = text.getBoundingClientRect()
      const pencil = text.parentElement!.querySelector("button")!
      const button = pencil.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(text)
      const fragments = [...range.getClientRects()].filter((r) => r.top < area.bottom && r.bottom > area.top)
      const last = fragments.at(-1)!
      const title = text.hasAttribute("data-inline-rename-text")
      const clipped = text.scrollHeight > text.clientHeight + 1
      const ellipsis = document.createElement("span")
      ellipsis.style.cssText = `position:fixed;visibility:hidden;font:${getComputedStyle(text).font}`
      ellipsis.textContent = "…"
      document.body.append(ellipsis)
      const ellipsisWidth = ellipsis.getBoundingClientRect().width
      ellipsis.remove()
      const end = title ? Math.min(area.right, last.right + (clipped ? ellipsisWidth : 0)) : area.right
      return {
        title,
        gap: button.left - end,
        pencilBottom: button.bottom,
        textBottom: area.bottom,
        right: button.right,
        headerRight: bounds.right,
        height: area.height,
        lineHeight: parseFloat(getComputedStyle(text).lineHeight),
        top: text.parentElement!.getBoundingClientRect().top,
        bottom: text.parentElement!.getBoundingClientRect().bottom,
        overflow: getComputedStyle(text).textOverflow
      }
    })
  })
  expect.soft(geometry).toHaveLength(3)
  for (const row of geometry) {
    expect.soft(row.gap, JSON.stringify(row)).toBeGreaterThanOrEqual(1)
    expect.soft(row.gap, JSON.stringify(row)).toBeLessThanOrEqual(3)
    expect.soft(row.right).toBeLessThanOrEqual(row.headerRight + 1)
    expect.soft(Math.abs(row.pencilBottom - row.textBottom)).toBeLessThanOrEqual(row.title ? 1 : 6)
    expect.soft(row.height).toBeLessThanOrEqual(row.lineHeight * (row.title ? 2 : 1) + (row.title ? 1 : 7))
    if (!row.title) expect.soft(row.overflow).toBe("ellipsis")
  }
  // A normal 4 px stack instead of space distributed over the portrait's height.
  for (let i = 1; i < geometry.length; i++)
    expect.soft(Math.abs(geometry[i]!.top - geometry[i - 1]!.bottom - 4)).toBeLessThanOrEqual(1)
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
        // The names start at the portrait's top, without stretching the stack to its bottom.
        const { header: whole, portrait, first } = await measure(panel)
        expect.soft(Math.abs(portrait.y - first.y), `${name}: top`).toBeLessThanOrEqual(1)
        await expectInlineNames(panel)
        heights.push(whole.height)
        // "You" is on the persona's portrait, and only there.
        const badge = header.locator("[data-card-header-portrait]").getByText("You", { exact: true })
        await expect.soft(badge).toHaveCount(name === PERSONA ? 1 : 0)
      }
      // A persona's header is the same shape as a character's.
      expect.soft(Math.abs(heights[0]! - heights[1]!), `short-card heights ${heights.join(",")}`).toBeLessThanOrEqual(1)
    })

test("the picture's controls are over it, and reached by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const panel = await open(page, NAMED)
  const portrait = panel.locator("[data-card-header-portrait]")
  const area = await box(portrait)
  const view = panel.getByRole("button", { name: `View ${NAMED}'s picture`, exact: true })
  // One button over the picture, in its lower-right corner, and nothing else (no camera over it).
  await expect(portrait.locator("[data-portrait-controls] button")).toHaveCount(1)
  const picture = panel.getByRole("button", { name: "Picture", exact: true })
  const at = await box(picture)
  expect(at.y + at.height).toBeLessThanOrEqual(area.y + area.height + 0.5)
  expect(at.y + at.height).toBeGreaterThan(area.y + area.height - 12)
  expect(at.x + at.width).toBeLessThanOrEqual(area.x + area.width + 0.5)
  expect(at.x + at.width).toBeGreaterThan(area.x + area.width - 12)
  // Faint until the picture is hovered or the button has the keyboard's focus.
  const opacity = (locator: Locator) =>
    locator.evaluate((element) => Number(getComputedStyle(element.closest("[data-portrait-controls]")!).opacity))
  await page.mouse.move(0, 0)
  await expect.poll(() => opacity(picture)).toBeLessThan(1)
  await view.focus()
  await page.keyboard.press("Tab")
  await expect(picture).toBeFocused()
  await expect.poll(() => opacity(picture)).toBe(1)
  await page.keyboard.press("Shift+Tab")
  await expect(view).toBeFocused()
  await view.hover()
  await expect.poll(() => opacity(picture)).toBe(1)
  await expect(page.getByText("View the whole picture", { exact: true })).toBeVisible()
  // It keeps its explanation.
  await picture.hover()
  await expect(
    page.getByText("Picture: adjust the cutout small portraits show, or replace the picture", { exact: true })
  ).toBeVisible()
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
        const { portrait, first } = await measure(page.locator("main"))
        expect.soft(Math.abs(portrait.y - first.y), `${name}: top`).toBeLessThanOrEqual(1)
        await expectInlineNames(page.locator("main"))
        // The same Picture button over it as in a character tab, with or without a picture.
        const over = page.locator("[data-card-header-portrait]")
        await expect(over.getByRole("button", { name: "Picture", exact: true })).toHaveCount(1)
        await expect(over.getByRole("button", { name: `View ${name}'s picture`, exact: true })).toHaveCount(
          name === NAMED ? 1 : 0
        )
        // Metadata's Picture: one large portrait, its own drop target, with the Picture button
        // over it, or an Add a picture box of the same size; the tags beside it.
        const metadata = await cardFieldsTab(page, "Metadata")
        const picture = metadata.getByRole("region", { name: "Picture" })
        if (name === NAMED) {
          await expect(picture.getByRole("button", { name: "Picture", exact: true })).toBeAttached()
          await expect(picture.locator("[data-portrait-controls] button")).toHaveCount(1)
        } else await expect(picture.getByRole("button", { name: "Add a picture", exact: true })).toBeVisible()
        await page.mouse.move(0, 0)
        await page.waitForTimeout(200)
        await shoot(page, `editor-metadata-${width}-${scheme}-${name.split(" ")[0]!.toLowerCase()}`)
      }
    }
})

test("a tag is added from a short field at the end of the chips", async ({ page }) => {
  for (const [width, panel] of [
    [1440, false],
    [1440, true]
  ] as const) {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    let scope: Locator
    if (panel) scope = await open(page, NAMED)
    else {
      const refs = await admin((api) => api.ListLibrary({ kind: "card" }))
      await page.goto(`${server().url}/library/${refs.find((ref) => ref.label === NAMED)!.id}`)
      scope = page.locator("main")
    }
    const metadata = await cardFieldsTab(scope, "Metadata")
    const tags = metadata.getByRole("list", { name: "Tags" })
    const field = tags.getByRole("textbox", { name: "New tag" })
    await expect(field).toBeVisible({ timeout: 30_000 })
    await shoot(
      panel ? page.getByRole("complementary", { name: "Chat panel" }) : page,
      `tags-before-${panel ? "panel" : "editor"}`
    )
    // In the chips' row, as tall as a chip, and short.
    const chip = await box(tags.getByRole("listitem").first())
    const entry = await box(metadata.locator("[data-new-tag]"))
    expect(Math.abs(chip.height - entry.height)).toBeLessThanOrEqual(1)
    // On the last chip's line, or starting the next line where the chips start.
    const last = await box(tags.getByRole("listitem").nth(-2))
    expect(
      Math.abs(last.y - entry.y) <= 1 || Math.abs(chip.x - entry.x) <= 1,
      JSON.stringify([chip, last, entry])
    ).toBe(true)
    expect(entry.width).toBeLessThan(200)
    const tag = panel ? "fog" : "harbour"
    await field.fill(tag)
    await field.press("Enter")
    await expect(tags.getByRole("listitem").filter({ hasText: tag })).toHaveCount(1)
    await expect(field).toHaveValue("")
    await field.fill(`${tag} two`)
    await tags.getByRole("button", { name: "Add the tag", exact: true }).click()
    await expect(tags.getByRole("listitem").filter({ hasText: `${tag} two` })).toHaveCount(1)
    await shoot(
      panel ? page.getByRole("complementary", { name: "Chat panel" }) : page,
      `tags-${panel ? "panel" : "editor"}`
    )
  }
})

test("the name explanations and nickname field use the owner's wording", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const panel = await open(page, PLAIN)
  await expect(panel.getByText("Add an in-chat nickname", { exact: true })).toBeVisible()
  const header = panel.locator("[data-card-header]")
  for (const [name, hint] of [
    ["display name", DISPLAY_HINT],
    ["nickname", NICKNAME_HINT]
  ]) {
    const pencil = header.getByRole("button", { name: `Rename the ${name}`, exact: true })
    await pencil.hover()
    await expect(page.getByText(hint!, { exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await page.keyboard.press("Tab")
    await pencil.focus()
    await expect(page.getByText(hint!, { exact: true })).toBeVisible()
  }
  await header.getByRole("button", { name: "Rename the nickname", exact: true }).click()
  await expect(header.getByRole("textbox", { name: "In-chat nickname", exact: true })).toHaveValue("")
  await header.getByRole("button", { name: "Cancel renaming" }).click()
})
