// Synthetic cards only: a persona locked to a character (DESIGN §2.2, owner 2026-11-18) from a
// new single chat's persona picker starts that character's next new chat; the character's tab
// shows and clears it; group chats and started chats are untouched. The same tests run in
// the focused layout audit (LAYOUT_AUDIT_PERSONALOCK_ONLY=1).
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./layoutAudit.ts"
import { closePanel, openPanel, panelTab } from "./panel.ts"
import { addToCast } from "./cast.ts"
import { loginCookie, withCookie } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"

const playing = (page: Page, name: string) =>
  page.getByRole("button", { name: `Playing as ${name}. Change your persona`, exact: true })
/** The composer's speaker chip on a new chat's page: Speak as, and Your persona under it. */
const speaking = (page: Page, name: string) =>
  page.getByRole("button", { name: `Speaking as ${name}. Change the speaker`, exact: true })

export function personaLockTests() {
  test.describe("persona lock", () => {
    test.setTimeout(180_000)
    const server = serverPerFile(withAdmin)
    let cookie = ""
    test.beforeAll(async () => {
      cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
    })
    const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        const suffix = `${width} ${theme}`
        test(`lock on the pending page, start with it, clear it from the character's tab ${suffix}`, async ({
          page
        }, info) => {
          const tag = `${width}${theme === "light" ? "L" : "D"}`
          const { harbor, pilot, mapmaker, group, started } = await admin((api) =>
            Effect.gen(function* () {
              const harbor = yield* api.CreateCard({ label: `Harbor ${tag}`, name: `Harbor ${tag}` })
              const partner = yield* api.CreateCard({ label: `Navigator ${tag}`, name: `Navigator ${tag}` })
              const pilot = yield* api.CreateCard({ label: `Pilot ${tag}`, name: `Pilot ${tag}` })
              const mapmaker = yield* api.CreateCard({ label: `Mapmaker ${tag}`, name: `Mapmaker ${tag}` })
              for (const card of [pilot, mapmaker]) yield* api.SetPersona({ entityId: card.entityId, persona: true })
              yield* api.ChangeGenerationDefaults({ change: { persona: mapmaker.entityId } })
              const group = yield* api.StartChat({
                cards: [harbor.entityId, partner.entityId],
                persona: mapmaker.entityId,
                greeting: null,
                first: { _tag: "Send", content: "Group fixture.", speakerEntityId: null },
                title: `Voyage ${tag}`
              })
              // A chat with Harbor that started before any lock.
              const started = yield* api.StartChat({
                cards: [harbor.entityId],
                persona: mapmaker.entityId,
                greeting: null,
                first: { _tag: "Send", content: "Started before the lock.", speakerEntityId: null },
                title: `Started ${tag}`
              })
              return { harbor, pilot, mapmaker, group: group.chat, started: started.chat }
            })
          )
          await page.setViewportSize({ width, height: 900 })
          await page.emulateMedia({ colorScheme: theme })
          await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
          const lock = () => admin((api) => api.GetPersonaLock({ entityId: harbor.entityId }))
          const name = (card: { label: string }) => card.label

          // The new chat starts with the account default. The composer's speaker chip, where a
          // user picks their persona on a new chat's page, offers the lock, off.
          await page.goto(`${server().url}/cards/${harbor.entityId}/chat`)
          await expect(speaking(page, name(mapmaker))).toBeVisible()
          await speaking(page, name(mapmaker)).click()
          const picker = page.getByRole("dialog", { name: "Speak as" })
          // The row names the persona picked; it follows the pick.
          const lockRow = (persona: string) =>
            picker.getByRole("checkbox", { name: `Always play as ${persona} with ${name(harbor)}`, exact: true })
          await expect(lockRow(name(mapmaker))).toBeVisible()
          await expect(lockRow(name(mapmaker))).not.toBeChecked()
          await expect(lockRow(name(mapmaker))).toHaveAccessibleDescription(
            `New chats with ${name(harbor)} start with this persona. Chats already started keep theirs.`
          )
          // A compact row of the list's own inset, under the list, not a settings switch above it.
          const listBox = (await picker.getByRole("listbox").boundingBox())!
          const rowBox = (await lockRow(name(mapmaker)).boundingBox())!
          expect(rowBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height - 1)
          expect(rowBox.height).toBeLessThanOrEqual(20)
          await picker
            .getByRole("group", { name: "Your persona" })
            .getByRole("option", { name: name(pilot), exact: true })
            .click()
          await expect(speaking(page, name(pilot))).toBeVisible()
          // Picking a persona alone locks nothing (DESIGN §2.2: it affects only this chat).
          expect(await lock()).toBeNull()
          await speaking(page, name(pilot)).click()
          const toggle = lockRow(name(pilot))
          await expect(toggle).not.toBeChecked()
          await picker.screenshot({ path: info.outputPath(`picker-unlocked.png`), animations: "disabled" })
          await expectLayout(page, info, `persona-lock-picker-unlocked-${suffix}`, { scope: '[role="dialog"]' })
          await toggle.click()
          await expect(toggle).toBeChecked()
          await expect.poll(async () => (await lock())?.entityId).toBe(pilot.entityId)
          await picker.screenshot({ path: info.outputPath(`picker-locked.png`), animations: "disabled" })
          await expectLayout(page, info, `persona-lock-picker-locked-${suffix}`, { scope: '[role="dialog"]' })
          await page.keyboard.press("Escape")

          // The pending chat's character tab shows it.
          const row = page.locator("[data-persona-lock]")
          await openPanel(page, "Cast")
          await panelTab(page, name(harbor))
          await expect(row).toContainText(`You play ${name(pilot)} with ${name(harbor)}`)

          // A second new chat with Harbor starts as the locked persona; a group's new chat does not.
          await page.goto(`${server().url}/cards/${harbor.entityId}/chat`)
          await openPanel(page, "Cast")
          await expect(playing(page, name(pilot))).toBeVisible()
          await page.goto(`${server().url}/groups/${group.id}/new`)
          await openPanel(page, "Cast")
          await expect(playing(page, `${name(mapmaker)} (default)`)).toBeVisible()

          // The chat started before the lock keeps its persona, and its Harbor tab clears the lock.
          await page.goto(`${server().url}/chats/${started.id}`)
          await openPanel(page, "Cast")
          await expect(playing(page, name(mapmaker))).toBeVisible()
          expect(
            (await admin((api) => api.GetCast({ chatId: started.id, slotId: started.activeLeafSlotId }))).playedByMe
          ).toEqual([mapmaker.entityId])
          await panelTab(page, name(harbor))
          await expect(row).toBeVisible()
          await expect(row).toContainText(`You play ${name(pilot)} with ${name(harbor)}`)
          const clear = row.getByRole("button", { name: "Clear", exact: true })
          await expect(clear).toHaveAccessibleDescription(
            `New chats with ${name(harbor)} start with your default persona again. Chats already started keep theirs.`
          )
          const tab = page.getByRole("tabpanel", { name: name(harbor) })
          await tab.screenshot({ path: info.outputPath(`character-tab.png`), animations: "disabled" })
          await expectLayout(page, info, `persona-lock-character-tab-${suffix}`, { scope: "[data-persona-lock]" })
          await expectLayout(page, info, `persona-lock-character-panel-${suffix}`, { scope: '[role="tabpanel"]' })
          await clear.click()
          await expect(row).toHaveCount(0)
          await expect.poll(async () => await lock()).toBeNull()
          expect(
            (await admin((api) => api.GetCast({ chatId: started.id, slotId: started.activeLeafSlotId }))).playedByMe
          ).toEqual([mapmaker.entityId])

          // New chats with Harbor are back to the account default.
          await page.goto(`${server().url}/cards/${harbor.entityId}/chat`)
          await openPanel(page, "Cast")
          await expect(playing(page, `${name(mapmaker)} (default)`)).toBeVisible()
        })
      }
    for (const width of [1440, 390])
      test(`only a single chat offers or shows the lock; another tab follows a change ${width}`, async ({
        page,
        context
      }) => {
        const tag = `${width}S`
        const { harbor, partner, pilot, group, started } = await admin((api) =>
          Effect.gen(function* () {
            const harbor = yield* api.CreateCard({ label: `Harbor ${tag}`, name: `Harbor ${tag}` })
            const partner = yield* api.CreateCard({ label: `Navigator ${tag}`, name: `Navigator ${tag}` })
            const pilot = yield* api.CreateCard({ label: `Pilot ${tag}`, name: `Pilot ${tag}` })
            yield* api.SetPersona({ entityId: pilot.entityId, persona: true })
            // No default: the new chat plays Pilot through the lock alone.
            yield* api.ChangeGenerationDefaults({ change: { persona: null } })
            yield* api.SetPersonaLock({ entityId: harbor.entityId, persona: pilot.entityId })
            const group = yield* api.StartChat({
              cards: [harbor.entityId, partner.entityId],
              persona: pilot.entityId,
              greeting: null,
              first: { _tag: "Send", content: "Group fixture.", speakerEntityId: null },
              title: `Voyage ${tag}`
            })
            const started = yield* api.StartChat({
              cards: [harbor.entityId],
              persona: pilot.entityId,
              greeting: null,
              first: { _tag: "Send", content: "Single fixture.", speakerEntityId: null },
              title: `Single ${tag}`
            })
            return { harbor, partner, pilot, group: group.chat, started: started.chat }
          })
        )
        await page.setViewportSize({ width, height: 900 })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const toggle = page.getByRole("checkbox", {
          name: `Always play as ${pilot.label} with ${harbor.label}`,
          exact: true
        })

        // Both pickers show the lock, the same row: the composer's and the Cast tab's.
        await page.goto(`${server().url}/cards/${harbor.entityId}/chat`)
        await speaking(page, pilot.label).click()
        await expect(page.getByRole("dialog", { name: "Speak as" })).toBeVisible()
        await expect(toggle).toBeChecked()
        await page.keyboard.press("Escape")
        await openPanel(page, "Cast")
        await playing(page, pilot.label).click()
        await expect(page.getByRole("dialog", { name: "Your persona" })).toBeVisible()
        await expect(toggle).toBeChecked()
        await page.keyboard.press("Escape")
        // A character joining the new chat makes it a group: neither picker offers the lock.
        await addToCast(page, partner.label)
        await playing(page, pilot.label).click()
        await expect(page.getByRole("dialog", { name: "Your persona" })).toBeVisible()
        await expect(toggle).toHaveCount(0)
        await page.keyboard.press("Escape")
        // On a phone the panel is a sheet over the composer.
        if (width < 700) await closePanel(page)
        await speaking(page, pilot.label).click()
        await expect(page.getByRole("dialog", { name: "Speak as" })).toBeVisible()
        await expect(toggle).toHaveCount(0)
        await page.keyboard.press("Escape")

        // A group chat's character tab doesn't show it; the single chat's does.
        const row = page.locator("[data-persona-lock]")
        await page.goto(`${server().url}/chats/${group.id}`)
        await openPanel(page, "Cast")
        await panelTab(page, harbor.label)
        await expect(page.getByRole("tabpanel", { name: harbor.label })).toContainText(`New chat with ${harbor.label}`)
        await expect(row).toHaveCount(0)

        // Another tab showing the lock follows a change made here, without a reload.
        const other = await context.newPage()
        await other.setViewportSize({ width, height: 900 })
        for (const view of [page, other]) {
          await view.goto(`${server().url}/chats/${started.id}`)
          await openPanel(view, "Cast")
          await panelTab(view, harbor.label)
          await expect(view.locator("[data-persona-lock]")).toContainText(
            `You play ${pilot.label} with ${harbor.label}`
          )
        }
        await page.locator("[data-persona-lock]").getByRole("button", { name: "Clear", exact: true }).click()
        await expect(row).toHaveCount(0)
        await expect(other.locator("[data-persona-lock]")).toHaveCount(0)
        // And a lock set elsewhere appears.
        await admin((api) => api.SetPersonaLock({ entityId: harbor.entityId, persona: pilot.entityId }))
        await page.bringToFront()
        await page.evaluate(() => window.dispatchEvent(new Event("focus")))
        await expect(row).toContainText(`You play ${pilot.label} with ${harbor.label}`)
        await other.close()
      })
  })
}
