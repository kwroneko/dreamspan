// Screenshots of the save cluster wherever it appears (ui/SaveControls.tsx), in each state, at
// 1440 and 390 px, light and dark; only with SCREENSHOT_DIR set. Saving is held and a failure
// made by catching the save on its way to the server. Every card, book and preset is made up.
import { switchAll } from "./support/lorebook.ts"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel, panelTab } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const shots = process.env.SCREENSHOT_DIR
const server = serverPerFile(withAdmin)
test.describe.configure({ mode: "parallel" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

type Mode = "pass" | "hold" | "fail"

const upload = async (page: Page, name: string, data: unknown) => {
  const response = await page.request.post(`${server().url}/library/import?name=${encodeURIComponent(name)}.json`, {
    data: Buffer.from(JSON.stringify(data)),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
}

const typeAtEnd = async (page: Page, box: Locator, text: string) => {
  await box.click()
  await page.keyboard.press("Control+End")
  await page.keyboard.insertText(text)
}

for (const width of [1440, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`save cluster screenshots at ${width}, ${scheme}`, async ({ page }) => {
      test.skip(!shots, "screenshots only")
      test.setTimeout(1_200_000)
      const dir = join(shots!, `${width}-${scheme}`)
      mkdirSync(dir, { recursive: true })
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      let mode: Mode = "pass"
      const held: Array<() => void> = []
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          if (typeof data === "string" && data.includes('"CommitEditorDrafts"')) {
            if (mode === "hold") return void held.push(() => upstream.send(data))
            if (mode === "fail") {
              const frame = JSON.parse(data)
              frame.payload.refId = "00000000-0000-0000-0000-000000000000"
              return upstream.send(JSON.stringify(frame))
            }
          }
          upstream.send(data)
        })
        upstream.onMessage((data) => socket.send(data))
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const tag = `${width}${scheme}`
      await upload(page, `Mira ${tag}`, {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name: `Mira ${tag}`, description: "Keeps the ledger.", first_mes: "The lamp turns." }
      })
      await upload(page, `Tides ${tag}`, {
        name: `Tides ${tag}`,
        entries: {
          0: { uid: 0, key: ["tide"], comment: "Tides", content: "The tide comes in twice a day.", order: 1 },
          1: { uid: 1, key: ["fog"], comment: "Fog", content: "Fog rolls in at dusk.", order: 2 }
        }
      })
      const ids = await admin((api) =>
        Effect.gen(function* () {
          const preset = yield* api.CreatePreset({ label: `Preset ${tag}` })
          yield* api.ChangeGenerationDefaults({ change: { preset: preset.id } })
          const book = (yield* api.ListLibrary({ kind: "lorebook" })).find((r) => r.label === `Tides ${tag}`)!
          const card = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === `Mira ${tag}`)!
          const chat = yield* api.CreateChat({ title: `Shots ${tag}` })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: null,
            change: { _tag: "Lorebook", ref: book.id, active: true }
          })
          yield* api.CreateSnippet({ chatId: chat.id, title: `Fragments ${tag}`, content: "Gulls at dawn." })
          return { preset: preset.id, book: book.id, card: card.id, chat: chat.id }
        })
      )

      const shoot = async (anchor: Locator, name: string) => {
        await anchor.scrollIntoViewIfNeeded()
        await page.mouse.move(width - 2, 2)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        const box = (await anchor.boundingBox())!
        const top = Math.max(0, box.y - 56)
        const bottom = Math.min(900, box.y + box.height + 56)
        await page.screenshot({ path: join(dir, `${name}.png`), clip: { x: 0, y: top, width, height: bottom - top } })
      }

      /** Each state of one surface: `edit` makes a change, `scope` holds its cluster. */
      const states = async (name: string, scope: () => Locator, edit: (n: number) => Promise<void>) => {
        const save = () => scope().getByRole("button", { name: "Save", exact: true })
        await expect(save()).toBeVisible({ timeout: 30_000 })
        await shoot(save(), `${name}-1-clean`)
        await page.screenshot({ path: join(dir, `${name}-0-page.png`) })
        await edit(1)
        await expect(save()).toBeEnabled({ timeout: 30_000 })
        await shoot(save(), `${name}-2-unsaved`)
        mode = "hold"
        await save().click()
        await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1)
        await shoot(save(), `${name}-3-saving`)
        mode = "pass"
        held.shift()!()
        await expect(save()).toBeDisabled({ timeout: 30_000 })
        await shoot(save(), `${name}-4-saved`)
        await page.waitForTimeout(2_500)
        await shoot(save(), `${name}-5-settled`)
        await edit(2)
        await expect(save()).toBeEnabled({ timeout: 30_000 })
        mode = "fail"
        await save().click()
        await page.waitForTimeout(1_500)
        mode = "pass"
        await shoot(save(), `${name}-6-failed`)
        await page.screenshot({ path: join(dir, `${name}-6-failed-page.png`) })
        // Leaves it saved for the next surface.
        await save().click()
        await expect(save()).toBeDisabled({ timeout: 30_000 })
      }

      // The library page: a card, a preset, a lorebook.
      // SHOTS_FROM=snippets takes only the surfaces from the snippets on (a rerun after a fix).
      if (process.env.SHOTS_FROM !== "snippets") {
        await page.goto(`${server().url}/library/${ids.card}`)
        await states(
          "library-card",
          () => page.locator("main"),
          (n) => typeAtEnd(page, page.getByRole("textbox", { name: "Description", exact: true }), ` Edit ${n}.`)
        )
        await page.goto(`${server().url}/library/${ids.preset}`)
        const main = page.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
        await states(
          "library-preset",
          () => page.locator("main"),
          async (n) => {
            if (!(await main.isVisible()))
              await page.getByRole("button", { name: "Expand Main Prompt", exact: true }).click()
            await typeAtEnd(page, main, ` Edit ${n}.`)
          }
        )
        await page.goto(`${server().url}/library/${ids.book}`)
        await states(
          "library-lorebook",
          () => page.locator("main"),
          (n) => switchAll(page, n === 1 ? "Disable all" : "Enable all")
        )

        // The chat's panel: the card's tab, its preset, its notes, snippets and lorebooks.
        await page.goto(`${server().url}/chats/${ids.chat}`)
        await openPanel(page, `Mira ${tag}`)
        const card = () => page.getByRole("tabpanel", { name: `Mira ${tag}`, exact: true })
        await states("panel-card", card, (n) =>
          typeAtEnd(page, card().getByRole("textbox", { name: "Description", exact: true }), ` Edit ${n}.`)
        )
        await panelTab(page, "Prompt preset")
        const preset = () => page.getByRole("tabpanel", { name: "Prompt preset", exact: true })
        await states("panel-preset", preset, async (n) => {
          const box = preset().getByRole("textbox", { name: "Prompt: Main Prompt", exact: true })
          if (!(await box.isVisible()))
            await preset().getByRole("button", { name: "Expand Main Prompt", exact: true }).click()
          await typeAtEnd(page, box, ` Edit ${n}.`)
        })
        // The held order's bar: a prompt moved.
        const bar = () => preset().getByRole("region", { name: "Unsaved changes" })
        await preset().getByRole("button", { name: "Collapse Main Prompt", exact: true }).click()
        await preset()
          .getByRole("button", { name: /^Move / })
          .nth(1)
          .focus()
        await page.keyboard.press("ArrowUp")
        await expect(bar()).toBeVisible()
        await shoot(bar(), "panel-held-2-unsaved")
        await page.screenshot({ path: join(dir, "panel-held-0-page.png") })
        mode = "hold"
        await bar().getByRole("button", { name: "Save", exact: true }).click()
        await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1)
        await shoot(preset().getByRole("button", { name: "Save", exact: true }).first(), "panel-held-3-saving")
        mode = "pass"
        held.shift()!()
        await expect(bar()).toHaveCount(0, { timeout: 30_000 })

        const notes = await openPanel(page, "Notes")
        await notes
          .getByRole("region", { name: "This chat's notes" })
          .getByRole("button", { name: "Add note", exact: true })
          .click()
        const note = () => page.getByRole("tabpanel", { name: "Notes" }).getByRole("region", { name: "Note Note" })
        await expect(note().getByRole("textbox", { name: /^Text of/ })).toBeVisible()
        await note()
          .getByRole("textbox", { name: /^Text of/ })
          .fill("A first line.")
        await note().getByRole("button", { name: "Save", exact: true }).click()
        await states("panel-note", note, (n) =>
          typeAtEnd(page, note().getByRole("textbox", { name: /^Text of/ }), ` Edit ${n}.`)
        )
      } else await page.goto(`${server().url}/chats/${ids.chat}`)

      await openPanel(page, "Snippets")
      const snippets = () => page.getByRole("tabpanel", { name: "Snippets" })
      const snippet = () => snippets().getByRole("region", { name: `Snippet Fragments ${tag}` })
      const toggle = snippet().getByRole("button", { name: new RegExp(`^(Expand|Collapse) Fragments ${tag}$`) })
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
      await states("panel-snippet", snippet, (n) =>
        typeAtEnd(page, snippet().getByRole("textbox", { name: `Text of Fragments ${tag}` }), ` Edit ${n}.`)
      )

      await openPanel(page, "Lorebooks")
      const lore = () => page.getByRole("tabpanel", { name: "Lorebooks" })
      await lore()
        .getByRole("button", { name: new RegExp(`^Tides ${tag}`) })
        .click()
      const book = () => lore().getByRole("region", { name: `Lorebook Tides ${tag}` })
      await states("panel-lorebook", book, (n) => switchAll(book(), n === 1 ? "Disable all" : "Enable all"))
    })
