// Synthetic cast portraits and long prose, measured at actual sidebar widths.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { crc32 } from "node:zlib"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { portraitPng } from "./support/portrait.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({
  ...withAdmin,
  ...(process.env.CHATROWNARROW_CLIENT_DIST ? { CLIENT_DIST: process.env.CHATROWNARROW_CLIENT_DIST } : {})
})
const before = process.env.CHATROWNARROW_BEFORE === "1"
const work = process.env.CHATROWNARROW_WORK
const preview = "The travelers discovered a lantern beside the harbor and waited together for the returning ship."
const titles = [
  "Solitary traveler watching the lanterns across the harbor",
  "Companions searching together for the forgotten harbor lanterns",
  "Travelers gathering beneath the lanterns before their departure"
]

// Embed a public-format card definition in generated pixels; no owner data.
function cardPng(name: string, variant: number) {
  const data = Buffer.from(
    `chara\0${Buffer.from(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name } })).toString("base64")}`
  )
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write("tEXt", 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8)
  return portraitPng([chunk], variant)
}

test.beforeAll(async ({ request }) => {
  await apiLogin(request, server(), ADMIN.handle, ADMIN.password)
  for (const [i, name] of ["Mira", "Wren", "Fern"].entries()) {
    const response = await request.post(`${server().url}/library/import?name=${name}.png`, {
      headers: { origin: server().url, "content-type": "application/octet-stream" },
      data: cardPng(name, i)
    })
    expect(response.ok()).toBe(true)
  }
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const cards = yield* api.ListLibrary({ kind: "card" })
      for (const [i, name] of titles.entries()) {
        const started = yield* api.StartChat({
          cards: cards.slice(0, i + 1).map((card) => card.entityId),
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: preview, speakerEntityId: cards[0]!.entityId }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name })
        yield* api.CreateFork({
          chatId: started.chat.id,
          fromForkId: null,
          atSlotId: started.chat.activeLeafSlotId,
          name: "Other harbor"
        })
      }
    })
  )
})

for (const [scene, panelWidth, viewport] of [
  ["minimum", 220, 1440],
  ["middle", 320, 1440],
  ["wide", 360, 1440],
  ["phone", 390, 390]
] as const) {
  test(`portraits, prose and browse controls at ${scene} width`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: viewport, height: 1200 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/?side=chats`)
    await showAppNavigation(page)
    const panel =
      viewport === 390
        ? page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
        : page.getByRole("complementary", { name: "Sidebar", exact: true })
    if (viewport !== 390) {
      const grip = page.getByRole("separator", { name: "Resize sidebar", exact: true })
      await grip.focus()
      await page.keyboard.press("Home")
      for (let width = 220; width < panelWidth; width += 10) await page.keyboard.press("ArrowRight")
      await expect(grip).toHaveAttribute("aria-valuenow", String(panelWidth))
    }
    const chats = panel.getByRole("region", { name: "Chats", exact: true })
    await expect(chats.locator("[data-chat-id]")).toHaveCount(3)
    const measurements = []
    for (const title of titles) {
      const button = chats.getByRole("link", { name: `Open chat ${title}`, exact: true })
      await button.scrollIntoViewIfNeeded()
      const result = await button.evaluate((button) => {
        const box = (el: Element) => {
          const r = el.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        }
        const heading = button.querySelector("[data-chat-title]")!
        const row = button.parentElement!
        const titleText = heading.firstChild!
        const words = [...(titleText.textContent ?? "").matchAll(/\S+/g)].map((match) => {
          const text = titleText.nodeType === Node.TEXT_NODE ? titleText : titleText.firstChild!
          const range = document.createRange()
          range.setStart(text, match.index)
          range.setEnd(text, match.index + match[0].length)
          return { word: match[0], lines: new Set([...range.getClientRects()].map((r) => r.top)).size }
        })
        return {
          row: box(row),
          open: box(button),
          text: box(heading.parentElement!),
          title: box(heading),
          portraits: [...button.querySelectorAll("[data-portrait]")].map(box),
          pin: box(row.querySelector("button[aria-label^='Pin '], button[aria-label^='Unpin ']")!),
          branches: box(row.querySelector("[data-branches-button]")!),
          date: box(button.querySelector("[data-row-when]")!),
          style: { wrap: getComputedStyle(heading).overflowWrap, clamp: getComputedStyle(heading).webkitLineClamp },
          words,
          rootRem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          container: getComputedStyle(row).containerName
        }
      })
      measurements.push({ label: title, ...result })
      if (work) {
        await mkdir(work, { recursive: true })
        await button
          .locator("..")
          .screenshot({ path: join(work, `${scene}-${titles.indexOf(title) + 1}-row.png`), animations: "disabled" })
      }
      if (!before) {
        expect(result.container).toBe("fork-row")
        const narrow = scene === "minimum"
        const overlap = scene === "middle" && title !== titles[0]
        expect(result.portraits).toHaveLength(title === titles[0] ? 1 : 2)
        if (narrow) {
          expect(result.text.top).toBeGreaterThanOrEqual(result.portraits[0]!.bottom + 7)
          expect(result.text.width).toBeCloseTo(result.open.width - 8, 0)
          expect(result.portraits[0]!.width).toBe(24)
          expect(result.portraits[0]!.height).toBe(36)
        } else {
          expect(result.text.width).toBeGreaterThanOrEqual(9 * result.rootRem)
          expect(result.portraits[0]!.width).toBe(32)
        }
        if (result.portraits.length === 2) {
          const [first, second] = result.portraits
          if (overlap || narrow) expect(second!.left - first!.left).toBeCloseTo(first!.width / 3, 0)
          else expect(second!.left - first!.right).toBe(2)
        }
        expect(result.words.every((word) => word.lines <= 1)).toBe(true)
        expect(result.style).toEqual({ wrap: "normal", clamp: "2" })
        expect(result.pin.right).toBeCloseTo(result.row.right - 9, 0)
        expect(result.pin.top).toBeCloseTo(result.row.top + 13, 0)
        if (narrow) {
          expect(result.branches.right + 8).toBeCloseTo(result.pin.left, 0)
          expect(result.branches.top).toBeCloseTo(result.pin.top, 0)
        } else {
          expect(result.branches.right).toBeCloseTo(result.pin.right, 0)
          expect(result.branches.bottom).toBeCloseTo(result.date.bottom, 0)
          expect(result.pin.bottom).toBeLessThanOrEqual(result.branches.top)
        }
      }
    }
    const bar = panel.locator('[aria-label="Chat filters and sorting"]')
    if (work) {
      await mkdir(work, { recursive: true })
      await panel.screenshot({ path: join(work, `${scene}.png`), animations: "disabled" })
      await chats.screenshot({ path: join(work, `${scene}-rows.png`), animations: "disabled" })
      await bar.screenshot({ path: join(work, `${scene}-filter.png`), animations: "disabled" })
      await writeFile(join(work, `${scene}.json`), JSON.stringify(measurements, null, 2))
    }
    for (const name of ["All", "Pinned", "Group chats", "One-on-one", "With branches"]) {
      const filter = bar.getByRole("combobox", { name: "Show chats" })
      await filter.click()
      await page.getByRole("option", { name: new RegExp(`^${name} ·`) }).click()
      const fit = await filter.evaluate((el) => {
        const value = el.firstElementChild!
        return { text: value.textContent, available: value.clientWidth, needed: value.scrollWidth }
      })
      if (!before) {
        const filterBox = (await filter.boundingBox())!
        const sortBox = (await bar.locator("[data-chat-sort]").boundingBox())!
        const barBox = (await bar.boundingBox())!
        if (sortBox.y > filterBox.y + 1) {
          expect(sortBox.y).toBeGreaterThanOrEqual(filterBox.y + filterBox.height + 4)
          expect(sortBox.x + sortBox.width).toBeCloseTo(barBox.x + barBox.width, 0)
        } else expect(filterBox.x + filterBox.width + 4).toBeLessThanOrEqual(sortBox.x + 1)
        if (scene === "minimum" && name === "With branches") expect(sortBox.y).toBeGreaterThan(filterBox.y)
        expect(fit.text).toContain(name)
        expect(fit.available).toBeGreaterThanOrEqual(fit.needed)
        if (process.env.LAYOUT_AUDIT)
          await expectLayout(page, info, `${scene}-${name}`, { scope: '[aria-label="Chat filters and sorting"]' })
      }
    }
    await bar.getByRole("combobox", { name: "Show chats" }).click()
    await page.getByRole("option", { name: /^All ·/ }).click()
    if (!before && process.env.LAYOUT_AUDIT)
      await expectLayout(page, info, scene, { scope: 'section[aria-label="Chats"]' })
    // Record the Characters tab's existing compact arrangement at identical widths.
    await panel
      .getByRole("group", { name: "Left panel" })
      .getByRole("button", { name: "Characters", exact: true })
      .click()
    const compact = panel.getByRole("combobox", { name: "Show", exact: true })
    await expect(compact).toBeVisible()
    if (work) {
      await compact.locator("../..").screenshot({ path: join(work, `${scene}-characters.png`) })
      await writeFile(
        join(work, `${scene}-characters.json`),
        JSON.stringify(
          await compact.evaluate((el) => ({
            width: el.getBoundingClientRect().width,
            text: el.textContent,
            available: el.firstElementChild!.clientWidth,
            needed: el.firstElementChild!.scrollWidth
          })),
          null,
          2
        )
      )
    }
  })
}
