// Synthetic fixtures: only user-created notes initialize both remembered expansion choices.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openNoteSettings, noteToggle } from "./support/notes.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

for (const width of [1440, 390]) {
  test.describe(`${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } })
    for (const surface of [
      "chat notes",
      "branch notes",
      "card section",
      "chat card editor",
      "library card editor"
    ] as const) {
      test(`${surface}: a new note reveals settings and remembers later collapses`, async ({ page }, info) => {
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const { card, chat, forkId } = await admin((api) =>
          Effect.gen(function* () {
            const card = yield* api.CreateCard({ label: "Mira", name: "Mira" })
            const chat = yield* api.CreateChat({ title: "New note discovery" })
            const forkId =
              surface === "branch notes"
                ? (yield* api.CreateFork({ chatId: chat.id, fromForkId: chat.currentForkId, atSlotId: null })).fork.id
                : chat.currentForkId
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
            for (const title of ["Existing", "Weather", "Tide", "Fog", "Bells", "Rope", "Lanterns"]) {
              if (surface === "chat notes" || surface === "branch notes")
                yield* api.CreateChatNote({ chatId: chat.id, forkId, title })
              else yield* api.CreateCardNote({ cardRefId: card.id, title })
            }
            return { card, chat, forkId }
          })
        )
        const open = async (page: Page): Promise<Locator> => {
          if (surface === "library card editor") {
            await page.goto(`${server().url}/library/${card.id}`)
            return cardFieldsTab(page, "Notes")
          }
          if (surface === "chat card editor") {
            await page.goto(`${server().url}/chats/${chat.id}?panel=card:${card.entityId}`)
            return cardFieldsTab(page.getByRole("tabpanel", { name: "Mira", exact: true }), "Notes")
          }
          await page.goto(`${server().url}/chats/${chat.id}?fork=${forkId}`)
          const tab = await openPanel(page, "Notes")
          return tab.getByRole("region", {
            name: surface === "chat notes" || surface === "branch notes" ? "This chat's notes" : "Mira's notes"
          })
        }
        let scope = await open(page)
        const existing = scope.getByRole("region", { name: "Note Existing", exact: true })
        // Remember a deliberate collapse, rather than relying on the default.
        await openNoteSettings(existing, "Existing")
        await existing.getByRole("button", { name: "Close these settings", exact: true }).click()
        await noteToggle(existing, "Existing").click()
        await scope.getByRole("button", { name: "Add note", exact: true }).click()
        const made = scope.getByRole("region", { name: "Note Note", exact: true })
        await expect(noteToggle(made, "Note")).toHaveAttribute("aria-expanded", "true")
        await expect(made.getByRole("button", { name: "Settings of Note", exact: true })).toHaveAttribute(
          "aria-expanded",
          "true"
        )
        await expect(made).toHaveAttribute("data-flashing")
        await expect(made.locator("header")).toBeInViewport({ ratio: 1 })
        for (const name of ["Position", "Role", "When it applies"]) {
          await expect(made.getByRole("combobox", { name, exact: true })).toBeVisible()
          await expect(made.getByRole("combobox", { name, exact: true })).toBeInViewport({ ratio: 1 })
        }
        await expect(made.getByRole("textbox", { name: "Text of Note", exact: true })).toBeVisible()
        await expect(noteToggle(existing, "Existing")).toHaveAttribute("aria-expanded", "false")
        await expect(existing.getByRole("button", { name: "Settings of Existing", exact: true })).toHaveAttribute(
          "aria-expanded",
          "false"
        )
        await expectLayout(page, info, `${surface}-${width}-new-note`, { scope: 'section[aria-label="Note Note"]' })
        await made.getByRole("button", { name: "Close these settings", exact: true }).click()
        await noteToggle(made, "Note").click()
        await page.reload()
        scope = await open(page)
        for (const title of ["Existing", "Note"]) {
          const block = scope.getByRole("region", { name: `Note ${title}`, exact: true })
          await expect(noteToggle(block, title)).toHaveAttribute("aria-expanded", "false")
          await noteToggle(block, title).click()
          await expect(block.getByRole("button", { name: `Settings of ${title}`, exact: true })).toHaveAttribute(
            "aria-expanded",
            "false"
          )
          await expect(block.getByRole("combobox")).toHaveCount(0)
        }
      })
    }
  })
}
