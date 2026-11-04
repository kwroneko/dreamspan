import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Locator } from "@playwright/test"
import { Effect } from "effect"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const before = process.env.SEARCHREPLACE_BEFORE === "1"
const shots = process.env.SCREENSHOT_DIR
const preset = JSON.parse(
  readFileSync(new URL("../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown>

for (const width of [1440, 390])
  for (const kind of ["card", "preset", "lorebook"] as const)
    for (const surface of ["large", "panel"] as const) {
      test(`${kind} ${surface} Search and replace ${width}`, async ({ page }) => {
        test.setTimeout(90_000)
        await page.setViewportSize({ width, height: 1000 })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const label = `Search ${kind} ${surface} ${width}`
        const upload = async (name: string, data: unknown) => {
          const response = await page.request.post(
            `${server().url}/library/import?name=${encodeURIComponent(name)}.json`,
            {
              data: Buffer.from(JSON.stringify(data)),
              headers: { origin: server().url, "content-type": "application/octet-stream" }
            }
          )
          expect(response.ok()).toBeTruthy()
        }
        await upload(`${label} card`, {
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {
            name: `${label} card`,
            description: "The keeper tends the keeper lamp.",
            first_mes: "Hello keeper.",
            character_book: {
              name: "Keeper notes",
              entries: [
                { keys: ["keeper"], content: "The keeper tends the lamp.", enabled: true, insertion_order: 1, id: 1 }
              ]
            }
          }
        })
        await upload(`${label} preset`, {
          ...preset,
          prompts: [
            {
              identifier: "main",
              name: "Main Prompt",
              role: "system",
              content: "The keeper tends the keeper lamp.",
              system_prompt: true
            }
          ],
          prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }]
        })
        await upload(`${label} book`, {
          name: `${label} book`,
          entries: {
            0: { uid: 0, key: ["keeper"], comment: "Keeper", content: "The keeper tends the keeper lamp.", order: 10 }
          }
        })
        const refs = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
          Effect.gen(function* () {
            const card = (yield* api.ListCards()).find((c) => c.name === `${label} card`)!
            const book = (yield* api.ListLibrary({ kind: "lorebook" })).find((r) => r.label === `${label} book`)!
            const prompt = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === `${label} preset`)!
            yield* api.ChangeGenerationDefaults({ change: { preset: prompt.id } })
            const chat = yield* api.CreateChat({ title: label })
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
            yield* api.ChangeCast({
              chatId: chat.id,
              slotId: null,
              change: { _tag: "Lorebook", ref: book.id, active: true }
            })
            const cardRef = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === `${label} card`)!
            return { card: cardRef.id, preset: prompt.id, lorebook: book.id, chat: chat.id }
          })
        )
        let root: Locator
        if (surface === "large") {
          await page.goto(`${server().url}/library/${refs[kind]}`)
          root = page.locator("main")
        } else {
          await page.goto(`${server().url}/chats/${refs.chat}`)
          root = await openPanel(
            page,
            kind === "card" ? `${label} card` : kind === "preset" ? "Prompt preset" : "Lorebooks"
          )
          if (kind === "lorebook") {
            await root
              .getByRole("button")
              .filter({ hasText: `${label} book` })
              .first()
              .click()
            root = root.getByRole("region", { name: `Lorebook ${label} book`, exact: true })
          }
        }
        if (kind === "lorebook")
          await root
            .getByRole("button", { name: /^Open / })
            .first()
            .click()
        if (kind === "preset") {
          const expand = root.getByRole("button", { name: "Expand all", exact: true })
          if (await expand.count()) await expand.click()
        }
        if (kind === "card") await expect(root.getByRole("textbox", { name: "Description", exact: true })).toBeVisible()
        const toggle = root.getByRole("button", { name: "Search and replace", exact: true })
        if (before && kind === "card" && surface === "panel") {
          await expect(root.getByRole("textbox", { name: "Description", exact: true })).toBeVisible()
        } else {
          await toggle.scrollIntoViewIfNeeded()
          const initial = await toggle.boundingBox()
          await toggle.click()
          if (!before) expect((await toggle.boundingBox())!.y).toBeCloseTo(initial!.y, 0)
          const finder = page.getByRole(before && kind === "card" ? "dialog" : "region", {
            name: "Search and replace",
            exact: true
          })
          await finder.getByRole("textbox", { name: "Find", exact: true }).fill("keeper")
          await finder.getByRole("textbox", { name: "Replace with", exact: true }).fill("warden")
          await finder.getByRole("button", { name: "Find", exact: true }).click()
          await expect(finder.getByRole("status")).toContainText("matches.")
          if (!before) {
            await expect(toggle).toHaveAttribute("aria-pressed", "true")
            const marks = root.locator(kind === "lorebook" ? "mark" : ".rp-search-match")
            await expect(marks.filter({ hasText: "keeper" }).first()).toBeVisible()
            // Highlights remain visible without moving focus out of the search controls.
            await finder.getByRole("textbox", { name: "Replace with", exact: true }).focus()
            await expect(marks.filter({ hasText: "keeper" }).first()).toBeVisible()
          }
          if (shots) {
            mkdirSync(shots, { recursive: true })
            await root.screenshot({ path: join(shots, `${kind}-${surface}-${width}.png`) })
          }
          if (!before) {
            await finder.getByRole("button", { name: "Replace all", exact: true }).click()
            await expect(finder.getByRole("status")).toHaveText("No matches.")
            await expect(root.locator(".rp-search-match")).toHaveCount(0)
            await finder.getByRole("textbox", { name: "Find", exact: true }).fill("warden")
            await finder.getByRole("button", { name: "Find", exact: true }).click()
            await expect(finder.getByRole("status")).toContainText("matches.")
            await finder.getByRole("button", { name: "Close", exact: true }).click()
            await expect(toggle).toHaveAttribute("aria-pressed", "false")
            await expect(root.locator(".rp-search-match")).toHaveCount(0)
          }
        }
        if (shots && before && kind === "card" && surface === "panel") {
          mkdirSync(shots, { recursive: true })
          await root.screenshot({ path: join(shots, `${kind}-${surface}-${width}.png`) })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      })
    }
