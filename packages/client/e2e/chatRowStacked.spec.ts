// The stacked row keeps the actions above compact text, including empty previews.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const work = process.env.CHATROWS_WORK
const before = process.env.CHATROWS_BEFORE === "1"

test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const a = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const b = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      for (const preview of [true, false]) {
        for (const forks of [true, false]) {
          const started = yield* api.StartChat({
            cards: [a.entityId, b.entityId],
            persona: null,
            greeting: null,
            first: {
              _tag: "Send",
              content: "The travelers wait beside the harbor lantern.",
              speakerEntityId: a.entityId
            }
          })
          yield* api.RenameChat({
            chatId: started.chat.id,
            name: `${preview ? "Preview" : "Empty"}, ${forks ? "forks" : "single"}`
          })
          if (!preview) yield* api.DeleteMessage({ slotId: started.entry.slotId })
          if (forks)
            yield* api.CreateFork({
              chatId: started.chat.id,
              fromForkId: null,
              atSlotId: preview ? started.entry.slotId : null
            })
        }
      }
    })
  )
})

for (const width of [1440, 280])
  for (const theme of ["light", "dark"] as const)
    test(`stacked chat spacing at ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1200 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/?side=chats`)
      await showAppNavigation(page)
      if (width === 1440) {
        await page.getByRole("separator", { name: "Resize sidebar", exact: true }).focus()
        await page.keyboard.press("Home")
      }
      const panel =
        width === 1440
          ? page.getByRole("complementary", { name: "Sidebar", exact: true })
          : page.locator('[data-layout-overlay="Mobile navigation drawer covers the page"]')
      const chats = panel.getByRole("region", { name: "Chats", exact: true })
      await expect(chats.locator("[data-fork-row]")).toHaveCount(4)
      const measurements = []
      for (const row of await chats.locator("[data-fork-row]").all()) {
        const result = await row.evaluate((row) => {
          const rect = (el: Element) => {
            const r = el.getBoundingClientRect()
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
          }
          const text = row.querySelector("[data-row-text]")!
          const lines = [...text.children].map(rect)
          const pin = rect(row.querySelector("button[aria-label^='Pin '], button[aria-label^='Unpin ']")!)
          const branches = row.querySelector("[data-branches-button]")
          return {
            title: text.firstElementChild!.textContent,
            row: rect(row),
            lines,
            gaps: lines.slice(1).map((line, i) => line.top - lines[i]!.bottom),
            portraits: rect(row.querySelector("[data-row-portraits]")!),
            pin,
            branches: branches ? rect(branches) : null
          }
        })
        measurements.push(result)
        if (!before) {
          expect(result.lines[0]!.top - result.portraits.bottom).toBe(8)
          for (const gap of result.gaps) expect(gap).toBe(4)
          expect(result.pin.top).toBe(result.portraits.top)
          expect(result.row.bottom - result.lines.at(-1)!.bottom).toBe(13)
          if (result.branches) {
            expect(result.branches.top).toBe(result.pin.top)
            expect(result.pin.left - result.branches.right).toBe(8)
          }
        }
      }
      if (!before) expect(new Set(measurements.map((m) => m.row.right - m.pin.right)).size).toBe(1)
      if (work) {
        await mkdir(work, { recursive: true })
        await chats.screenshot({ path: join(work, `${width}-${theme}-rows.png`) })
        await writeFile(join(work, `${width}-${theme}.json`), JSON.stringify(measurements, null, 2))
      }
      if (!before && process.env.LAYOUT_AUDIT)
        await expectLayout(page, info, `stacked-${width}-${theme}`, { scope: 'section[aria-label="Chats"]' })
    })
