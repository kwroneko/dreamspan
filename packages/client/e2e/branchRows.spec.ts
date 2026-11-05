import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const referenceClient = process.env.BRANCHROWS_REFERENCE_CLIENT
const server = serverPerFile({ ...withAdmin, ...(referenceClient ? { CLIENT_DIST: referenceClient } : {}) })
for (const theme of ["light", "dark"] as const)
  for (const size of ["minimum", "1440", "phone"] as const)
    test(`branch additions and compact selected rename ${size} ${theme}`, async ({ page }, info) => {
      const data = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const cards = [yield* api.CreateCard({ label: "Mira", name: "Mira" })]
          for (const name of ["Tam", "Nell", "Sora"]) cards.push(yield* api.CreateCard({ label: name, name }))
          const { chat } = yield* api.StartChat({
            cards: [cards[0]!.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "A shared beginning.", speakerEntityId: null }
          })
          const original = (yield* api.ListForks({ chatId: chat.id }))[0]!
          const make = (name: string, count: number) =>
            Effect.gen(function* () {
              const { fork } = yield* api.CreateFork({
                chatId: chat.id,
                fromForkId: original.id,
                atSlotId: original.tipSlotId
              })
              yield* api.NameFork({ forkId: fork.id, name })
              for (const card of cards.slice(1, count + 1))
                yield* api.ChangeCast({
                  chatId: chat.id,
                  forkId: fork.id,
                  slotId: original.tipSlotId,
                  change: { _tag: "Join", entityId: card.entityId }
                })
              if (count > 0)
                yield* api.SendMessage({
                  chatId: chat.id,
                  forkId: fork.id,
                  parentSlotId: original.tipSlotId,
                  content: "The branch continues.",
                  branch: false
                })
              return fork
            })
          yield* make("Quiet checkpoint", 0)
          yield* make("One companion", 1)
          const selected = yield* make("Three companions", 3)
          return { chat, selected }
        })
      )
      await page.setViewportSize({ width: size === "phone" ? 390 : 1440, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await page.goto(`${server().url}/chats/${data.chat.id}?fork=${data.selected.id}&side=chats&forks=${data.chat.id}`)
      if (size === "phone") await page.getByRole("button", { name: "Chats and menu" }).click()
      if (size === "minimum") {
        await page.getByRole("separator", { name: "Resize sidebar", exact: true }).focus()
        await page.keyboard.press("Home")
      }
      const panel =
        size === "phone"
          ? page.locator(".fixed.inset-0")
          : page.getByRole("complementary", { name: "Sidebar", exact: true })
      const row = (name: string) =>
        panel
          .locator("[data-fork-row]")
          .filter({ has: page.getByRole("button", { name: `Open branch ${name}`, exact: true }) })
      const selected = row("Three companions")
      if (referenceClient) {
        await expect(panel.getByRole("button", { name: "Open branch Three companions", exact: true })).toBeVisible()
        await panel.screenshot({ path: info.outputPath(`before-${size}-${theme}.png`) })
        return
      }
      await expect(selected).toBeVisible()
      await expect(panel.getByRole("button", { name: /^Rename branch / })).toHaveCount(1)
      await expect(selected.locator("[data-added-portraits]")).toHaveAccessibleName("Added characters: Tam, Nell, Sora")
      await expect(selected.locator("[data-added-portraits] [data-portrait]")).toHaveCount(2)
      await expect(selected.locator("[data-portrait-overflow]")).toHaveText("+1")
      await selected.locator("[data-added-portraits]").hover()
      await expect(page.getByText("Added characters: Tam, Nell, Sora", { exact: true })).toHaveText(
        "Added characters: Tam, Nell, Sora"
      )
      await page.mouse.move(0, 0)
      await expect(row("One companion").locator("[data-portrait]")).toHaveCount(1)
      await expect(row("Quiet checkpoint").locator("[data-added-portraits]")).toHaveCount(0)
      await expect(row("Original").locator("[data-added-portraits]")).toHaveCount(0)
      await panel.screenshot({ path: info.outputPath(`branches-${size}-${theme}.png`) })
      const height = (await selected.boundingBox())!.height
      const pencilHeights = await selected.evaluate((root) => {
        const pencil = root.querySelector<HTMLButtonElement>('button[aria-label^="Rename branch "]')!
        const withPencil = root.getBoundingClientRect().height
        pencil.style.display = "none"
        const withoutPencil = root.getBoundingClientRect().height
        pencil.style.removeProperty("display")
        return { withPencil, withoutPencil }
      })
      expect(pencilHeights.withPencil).toBe(pencilHeights.withoutPencil)
      await selected.getByRole("button", { name: "Rename branch Three companions", exact: true }).click()
      const input = selected.getByRole("textbox", { name: "New name for branch Three companions" })
      await expect(input).toBeVisible()
      const editingHeight = (await selected.boundingBox())!.height
      expect(editingHeight).toBe(height)
      await info.attach("row heights", {
        body: JSON.stringify({ before: height, editing: editingHeight, ...pencilHeights }),
        contentType: "application/json"
      })
      await input.fill("Changed name")
      await input.press("Escape")
      await expect(input).toHaveCount(0)
      await selected.getByRole("button", { name: "Rename branch Three companions", exact: true }).click()
      await input.fill("New companions")
      await input.press("Enter")
      await expect(row("New companions")).toBeVisible()
      expect((await row("New companions").boundingBox())!.height).toBe(height)
      await row("New companions").getByRole("button", { name: "Rename branch New companions", exact: true }).click()
      await expect(row("New companions").getByRole("button", { name: "Save the name", exact: true })).toBeVisible()
      await row("New companions").getByRole("button", { name: "Cancel renaming", exact: true }).click()
      await row("New companions").getByRole("button", { name: "Rename branch New companions", exact: true }).click()
      await row("New companions").getByRole("textbox").fill("Saved companions")
      await row("New companions").getByRole("button", { name: "Save the name", exact: true }).click()
      await expect(row("Saved companions")).toBeVisible()
      await expectLayout(page, info, `branch-list-${size}-${theme}`, { scope: "[data-fork-row]" })
      await panel.screenshot({ path: info.outputPath(`renamed-${size}-${theme}.png`) })
    })
