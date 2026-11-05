// All sidebar row lists share the chat row's 40rem cap, including the independent
// bottom branch section. Fixtures are synthetic; screenshots also support before/after review.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const before = process.env.ROW_WIDTH_BEFORE === "1"
const screens = process.env.SCREENSHOT_DIR
test.setTimeout(120_000)

let chatId = ""
let characterId = ""
test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const wren = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      characterId = mira.entityId
      for (const [name, cards] of [
        ["Harbor watch", [mira.entityId]],
        ["Harbor companions", [mira.entityId, wren.entityId]]
      ] as const) {
        const started = yield* api.StartChat({
          cards: [...cards],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "The harbor lamps glow at dusk.", speakerEntityId: mira.entityId }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name })
        if (name !== "Harbor watch") continue
        chatId = started.chat.id
        const original = (yield* api.ListForks({ chatId: started.chat.id }))[0]!
        yield* api.PinFork({ forkId: original.id, pinned: true })
        yield* api.SetChatPin({ chatId: started.chat.id, leaf: null, pinned: true })
        for (const name of ["North quay", "South quay"]) {
          const peer = (yield* api.CreateFork({
            chatId: started.chat.id,
            fromForkId: original.id,
            atSlotId: original.tipSlotId
          })).fork
          yield* api.NameFork({ forkId: peer.id, name })
        }
      }
    })
  )
})

for (const theme of ["light", "dark"] as const)
  test(`sidebar rows stay aligned at default and dragged-wide widths (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    const sidebar = page.getByRole("complementary", { name: "Sidebar", exact: true })
    const grip = page.getByRole("separator", { name: "Resize sidebar", exact: true })
    const geometry: Record<string, unknown> = {}
    const capture = async (scene: string, size: string) => {
      const rows = sidebar.locator("div:has(> [data-chat-id])")
      await expect(rows.first()).toBeVisible()
      const boxes = await rows.evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect()
          return { label: node.textContent, x: box.x, width: box.width }
        })
      )
      geometry[`${size}-${scene}`] = boxes
      const first = boxes[0]!
      for (const box of boxes) {
        expect(
          Math.abs(box.x - first.x),
          `${scene}: row alignment of ${box.label} with ${first.label}`
        ).toBeLessThanOrEqual(1)
        if (!before) {
          expect(box.width, `${scene}: ${box.label}`).toBeLessThanOrEqual(640)
          expect(Math.abs(box.width - first.width), `${scene}: shared width`).toBeLessThanOrEqual(1)
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
      if (screens) {
        await mkdir(screens, { recursive: true })
        await page.screenshot({ path: join(screens, `${size}-${scene}-${theme}.png`), animations: "disabled" })
      }
    }
    for (const size of ["default", "wide"]) {
      await page.goto(`${server().url}/chats/${chatId}`)
      if (size === "wide") {
        const box = (await grip.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + 100)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + 700, box.y + 100, { steps: 10 })
        await page.mouse.up()
        await expect(grip).toHaveAttribute("aria-valuenow", "1020")
      } else await expect(grip).toHaveAttribute("aria-valuenow", "320")
      await expect(sidebar.getByRole("region", { name: "Pinned chats", exact: true })).toBeVisible()
      await expect(sidebar.getByRole("region", { name: "Branches of the open chat" })).toBeVisible()
      await expect(sidebar.getByRole("region", { name: "Chats", exact: true }).locator("[data-chat-id]")).toHaveCount(2)
      await capture("chats-pins-bottom-branches", size)

      await sidebar.getByLabel("Find a chat", { exact: true }).fill("companions")
      await expect(sidebar.getByRole("region", { name: "Chats", exact: true }).locator("[data-chat-id]")).toHaveCount(1)
      await capture("search-groups", size)
      await page.goto(`${server().url}/chats/${chatId}?character=${characterId}`)
      await expect(sidebar.getByRole("region", { name: "Just Mira", exact: true })).toBeVisible()
      await expect(sidebar.getByRole("region", { name: "With others", exact: true })).toBeVisible()
      await capture("character-chats", size)

      await page.goto(`${server().url}/chats/${chatId}?forks=${chatId}`)
      await expect(
        sidebar.getByRole("region", { name: "Pinned branches", exact: true }).locator("[data-chat-id]")
      ).toHaveCount(1)
      await expect(sidebar.getByRole("region", { name: "Branches of the open chat" })).toHaveCount(0)
      await capture("branch-scope", size)
      await sidebar.getByLabel("Find a chat", { exact: true }).fill("South")
      await expect(sidebar.locator("[data-chat-id]")).toHaveCount(1)
      await capture("branch-search", size)
    }
    if (screens) await writeFile(join(screens, `geometry-${theme}.json`), JSON.stringify(geometry, null, 2))
  })
