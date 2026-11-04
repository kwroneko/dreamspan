import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const artifacts = process.env.CARD_HISTORY_ARTIFACTS

for (const width of [390, 1024, 1440]) {
  test(`side-panel revision History at ${width}`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const fixture = await admin((api) =>
      Effect.gen(function* () {
        const card = yield* api.CreateCard({ label: `Harbour ${width}`, name: `Harbour ${width}` })
        const persona = yield* api.CreateCard({ label: `Sailor ${width}`, name: `Sailor ${width}` })
        const preset = yield* api.CreatePreset({ label: `Style ${width}` })
        const started = yield* api.StartChat({
          cards: [card.entityId],
          persona: persona.entityId,
          greeting: null,
          first: { _tag: "Send", content: "A synthetic harbour.", speakerEntityId: null }
        })
        yield* api.ChangeCast({ chatId: started.chat.id, slotId: null, change: { _tag: "Preset", ref: preset.id } })
        return { card, persona, chat: started.chat }
      })
    )
    const imported = await page.request.post(`${server().url}/library/import?name=Harbour-book.json`, {
      headers: { "content-type": "application/octet-stream", origin: server().url },
      data: Buffer.from(
        JSON.stringify({
          name: `Waters ${width}`,
          entries: { 0: { uid: 0, key: ["harbour"], content: "The water is calm.", comment: "Harbour" } }
        })
      )
    })
    expect(imported.status()).toBe(200)
    const book = (await imported.json()).library.ref
    await admin((api) =>
      api.ChangeCast({
        chatId: fixture.chat.id,
        slotId: null,
        change: { _tag: "Lorebook", ref: book.id, active: true }
      })
    )
    for (const [kind, tab] of [
      ["card", fixture.card.label],
      ["persona", fixture.persona.label],
      ["preset", "Prompt preset"],
      ["lorebook", "Lorebooks"]
    ]) {
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      let panel = await openPanel(page, tab!)
      if (kind === "lorebook") {
        await panel.getByRole("button").filter({ hasText: book.label }).first().click()
        panel = panel.getByRole("region", { name: `Lorebook ${book.label}`, exact: true })
      }
      const search = panel.getByRole("button", { name: "Search and replace", exact: true })
      await expect(search).toBeVisible()
      const row =
        kind === "lorebook" ? panel.getByRole("toolbar", { name: "Editing", exact: true }) : search.locator("..")
      await row.evaluate((el) => el.setAttribute("data-cardhistory-audit", ""))
      if (artifacts) {
        mkdirSync(artifacts, { recursive: true })
        await search.locator("..").screenshot({ path: `${artifacts}/${kind}-${width}.png` })
      }
      if (process.env.CARD_HISTORY_BEFORE) continue
      if (process.env.LAYOUT_AUDIT)
        await expectLayout(page, info, `${kind}-${width}`, { scope: "[data-cardhistory-audit]" })
      const history = panel.getByRole("button", { name: "History", exact: true })
      await expect(history).toHaveAccessibleDescription("Shows saved revisions to compare or restore.")
      await history.click()
      const dialog = page.getByRole("dialog", { name: "History", exact: true })
      await expect(dialog).toBeVisible()
      await expect(
        dialog
          .getByRole("list", { name: "Revisions", exact: true })
          .getByRole("button", { name: /^Revision/ })
          .first()
      ).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible()
      await dialog.getByRole("button", { name: "Close", exact: true }).click()
      await expect(history).toBeFocused()
    }
  })
}
