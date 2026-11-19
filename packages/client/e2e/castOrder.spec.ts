// Synthetic six-character chats: a row refreshes in place after another speaker replies.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { showAppNavigation } from "./support/appMenu.ts"

const server = serverPerFile(withAdmin)
const names = ["Mira", "Wren", "Aria", "River", "Ash", "Fern"]

for (const theme of ["light", "dark"] as const)
  test(`row follows the latest speaker, 1440 ${theme}`, async ({ page }, info) => {
    const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const cards = []
        for (const name of names) cards.push(yield* api.CreateCard({ label: name, name }))
        const started = yield* api.StartChat({
          cards: cards.map((card) => card.entityId),
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "The harbour lamps glow.", speakerEntityId: cards[0]!.entityId }
        })
        yield* api.RenameChat({ chatId: started.chat.id, name: "Harbour six" })
        return { started, speaker: cards[5]!.entityId }
      })
    )
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${fixture.started.chat.id}?side=chats`)
    await showAppNavigation(page)
    const row = page
      .getByRole("complementary", { name: "Sidebar", exact: true })
      .locator("[data-fork-row]")
      .filter({ has: page.locator(`[data-chat-id="${fixture.started.chat.id}"]`) })
      .first()
    const portraits = row.locator("[data-row-portraits]")
    await expect(portraits).toHaveAttribute("aria-label", `Characters: ${names.join(", ")}`)
    const visibleFaces = portraits.locator("[data-portrait]").filter({ visible: true })
    await expect(visibleFaces).toHaveCount(2)
    const before = await visibleFaces.allTextContents()
    await row.screenshot({ path: info.outputPath(`before-six-${theme}.png`) })
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.SendMessage({
        chatId: fixture.started.chat.id,
        parentSlotId: fixture.started.entry.slotId,
        speakerEntityId: fixture.speaker,
        content: "Fern answers from the quay.",
        branch: false
      })
    )
    const ordered = ["Fern", ...names.slice(0, 5)]
    await expect(portraits).toHaveAttribute("aria-label", `Characters: ${ordered.join(", ")}`)
    await expect.poll(() => visibleFaces.allTextContents()).not.toEqual(before)
    await row.screenshot({ path: info.outputPath(`after-six-${theme}.png`) })
    await portraits.hover()
    await expect(
      page
        .locator('[data-layout-overlay="Tooltip floats above the page"]')
        .filter({ hasText: `Characters: ${ordered.join(", ")}` })
    ).toBeVisible()
    // Shared home tiles consume the same shell order.
    await page.goto(`${server().url}/`)
    const tile = page
      .locator("[data-fork-row]")
      .filter({ has: page.locator(`[data-chat-id="${fixture.started.chat.id}"]`) })
      .first()
    await expect(tile.locator("[data-row-portraits]")).toHaveAttribute(
      "aria-label",
      `Characters: ${ordered.join(", ")}`
    )
  })
