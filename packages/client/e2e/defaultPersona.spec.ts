// Synthetic personas only: the account default starts new chats; a pending/chat selection
// stays local. Menus, badges and the same single/group pending flow at both widths.
import { expect, test, type Page } from "@playwright/test"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { fixtureSql } from "../../server/test/support/lcmFixtures.ts"
import { openPanel, closePanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.setTimeout(120_000)

const playing = (page: Page, name: string) =>
  page.getByRole("button", { name: `Playing as ${name}. Change your persona`, exact: true })
const setting = () => admin((api) => api.GetGenerationDefaults())

for (const width of [1440, 390]) {
  test(`${width}: set, preselect, choose for one chat, change default and clear`, async ({ page }) => {
    const { a, b, character, group } = await admin((api) =>
      Effect.gen(function* () {
        const character = yield* api.CreateCard({ label: `Harbor ${width}`, name: `Harbor ${width}` })
        const partner = yield* api.CreateCard({ label: `Navigator ${width}`, name: `Navigator ${width}` })
        const a = yield* api.CreateCard({ label: `Pilot ${width}`, name: `Pilot ${width}` })
        const b = yield* api.CreateCard({ label: `Mapmaker ${width}`, name: `Mapmaker ${width}` })
        for (const card of [a, b]) yield* api.SetPersona({ entityId: card.entityId, persona: true })
        yield* api.ChangeGenerationDefaults({ change: { persona: null } })
        const group = yield* api.StartChat({
          cards: [character.entityId, partner.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Group fixture.", speakerEntityId: null },
          title: `Voyage ${width}`
        })
        return { a, b, character, group: group.chat }
      })
    )
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    // Neither old browser memory nor the first persona is a default.
    await page.goto(server().url)
    await page.evaluate((id) => localStorage.setItem("rp.lastPersona", id), a.entityId)
    await page.goto(`${server().url}/cards/${character.entityId}/chat`)
    await openPanel(page, "Cast")
    await expect(playing(page, "No persona")).toBeVisible()

    // Set through the library's existing card menu. The badge and clearing action follow.
    await page.goto(`${server().url}/library?show=personas`)
    const libraryMore = page.getByRole("button", { name: `More actions for ${a.label}`, exact: true })
    const libraryMoreBefore = await libraryMore.boundingBox()
    await libraryMore.click()
    const setDefault = page.getByRole("menuitem", { name: "Set as default persona", exact: true })
    await setDefault.focus()
    await expect(setDefault).toHaveAccessibleDescription(
      "New story chats start with this persona. Existing chats keep theirs; workshops have their own."
    )
    await setDefault.click()
    await expect.poll(async () => (await setting()).persona).toBe(a.entityId)
    await expect(page.getByRole("main").locator("[data-default-persona]")).toHaveCount(1)
    expect((await libraryMore.boundingBox())!.y).toBeCloseTo(libraryMoreBefore!.y, 0)
    await page.goto(`${server().url}/cards/${a.entityId}`)
    await expect(page.getByRole("main").locator("[data-default-persona]")).toHaveCount(1)
    await page.goto(`${server().url}/cards/${character.entityId}/chat`)
    await openPanel(page, "Cast")
    await expect(playing(page, `${a.label} (default)`)).toBeVisible()
    await expect(
      page
        .getByRole("group", { name: "Your persona", exact: true })
        .getByRole("button", { name: `${a.label}: open your persona`, exact: true })
    ).toHaveText(`${a.label} (default)`)

    // A menu inside the picker changes the default without picking a persona or closing it.
    await playing(page, `${a.label} (default)`).click()
    const option = page.getByRole("option", { name: b.label, exact: true })
    await option.getByRole("button", { name: `Persona actions for ${b.label}` }).press("Enter")
    await page.getByRole("menuitem", { name: "Set as default persona", exact: true }).click()
    await expect.poll(async () => (await setting()).persona).toBe(b.entityId)
    await expect(playing(page, a.label)).toBeVisible()
    await expect(option).toBeVisible()
    await option.click()
    await expect(playing(page, `${b.label} (default)`)).toBeVisible()
    // Choose A on the pending page: the account remains B.
    await playing(page, `${b.label} (default)`).click()
    await page.getByRole("option", { name: a.label, exact: true }).click()
    await expect(playing(page, a.label)).toBeVisible()
    expect((await setting()).persona).toBe(b.entityId)

    await closePanel(page)
    // Save the chosen persona into a chat; no model is configured in this fixture.
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("A local persona choice.")
    await page.getByRole("button", { name: /^Send(?: as .+)?$/ }).click()
    await expect(page).toHaveURL(/\/chats\//)
    const chatId = new URL(page.url()).pathname.split("/")[2]!
    expect((await admin((api) => api.GetCast({ chatId: chatId as typeof group.id, slotId: null }))).playedByMe).toEqual(
      [a.entityId]
    )

    // Both kinds of new chat start with B.
    for (const path of [`/cards/${character.entityId}/chat`, `/groups/${group.id}/new`]) {
      await page.goto(`${server().url}${path}`)
      await openPanel(page, "Cast")
      await expect(playing(page, `${b.label} (default)`)).toBeVisible()
    }
    // The editor's existing More menu offers the same clear action.
    await page.goto(`${server().url}/library/${b.id}`)
    await expect(page.getByRole("textbox", { name: "Description", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Persona", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("main").locator("[data-default-persona]")).toHaveCount(1)
    const editorMore = page.getByRole("button", { name: "More actions", exact: true })
    const editorMoreBefore = await editorMore.boundingBox()
    await editorMore.click()
    await page.getByRole("button", { name: "Clear default persona", exact: true }).click()
    await expect.poll(async () => (await setting()).persona).toBeNull()
    await expect(page.getByRole("main").locator("[data-default-persona]")).toHaveCount(0)
    expect((await editorMore.boundingBox())!.y).toBeCloseTo(editorMoreBefore!.y, 0)
    await page.goto(`${server().url}/cards/${character.entityId}/chat`)
    await openPanel(page, "Cast")
    await expect(playing(page, "No persona")).toBeVisible()
    await page.goto(`${server().url}/chats/${chatId}`)
    await openPanel(page, "Cast")
    await page.getByRole("button", { name: `More for ${a.label}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Set as default persona", exact: true }).click()
    await expect.poll(async () => (await setting()).persona).toBe(a.entityId)
    const chat = await admin((api) => api.GetChat({ chatId: chatId as typeof group.id }))
    expect((await admin((api) => api.GetCast({ chatId: chat.id, slotId: chat.activeLeafSlotId }))).playedByMe).toEqual([
      a.entityId
    ])
  })
}

for (const state of ["archived", "deleted"] as const) {
  test(`${state} default card leaves new chats with no persona`, async ({ page }) => {
    const { persona, character } = await admin((api) =>
      Effect.gen(function* () {
        const persona = yield* api.CreateCard({ label: `Unavailable ${state}`, name: `Unavailable ${state}` })
        const character = yield* api.CreateCard({ label: `Live ${state}`, name: `Live ${state}` })
        yield* api.SetPersona({ entityId: persona.entityId, persona: true })
        yield* api.ChangeGenerationDefaults({ change: { persona: persona.entityId } })
        return { persona, character }
      })
    )
    // The fixture worker changes synthetic lifecycle state, never SQLite on the main thread.
    await Effect.runPromise(
      fixtureSql(server().dataDir, [
        {
          sql: `UPDATE entities SET ${state === "archived" ? "archived_at" : "deleted_at"} = ? WHERE id = ?`,
          params: [Date.now(), persona.entityId]
        }
      ])
    )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/cards/${character.entityId as EntityId}/chat`)
    await openPanel(page, "Cast")
    await expect(playing(page, "No persona")).toBeVisible()
    expect((await setting()).persona).toBeNull()
  })
}
