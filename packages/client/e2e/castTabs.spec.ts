// The cast strip in a group chat: each character tab says the character's name, and adds the
// card's version only when two characters' tabs would otherwise read alike ("Rowan Hale · main",
// "Rowan Hale · alt"); the persona sharing a character's name doesn't count (its tab has "you"),
// so both say the name only. Every tab but the open one collapses to its portrait the same way
// when the names don't fit, and the strip never overflows its panel, at 1340 and 390.
import { expect, test, type Locator } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const names = ["Seraphina Ashgrove", "Bartholomew Quill", "Evangeline Marsh"]
const twins = ["main", "alt"]
// Each tab's label: the characters in the chat's order, then the persona (you).
const labels = [...names, ...twins.map((version) => `Rowan Hale · ${version}`), names[0]!]
let chatId = ""

test.beforeAll(async () => {
  chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const [first, ...rest] = names
      const main = yield* api.CreateCard({ label: first!, name: first!, version: "main" })
      const others = []
      for (const name of rest) others.push(yield* api.CreateCard({ label: name, name }))
      for (const version of twins)
        others.push(yield* api.CreateCard({ label: "Rowan Hale", name: "Rowan Hale", version }))
      // The user's persona has the first character's name.
      const persona = yield* api.CreateCard({ label: first!, name: first!, version: "persona" })
      yield* api.SetPersona({ entityId: persona.entityId, persona: true })
      const chat = yield* api.CreateChat({ title: "Group" })
      for (const id of [main.entityId, ...others.map((card) => card.entityId), persona.entityId])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: id } })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [persona.entityId] }
      })
      return chat.id
    })
  )
})

/** The labels of the portrait tabs whose names are shown (not collapsed to the portrait). */
const expanded = async (tabs: Locator) => {
  const shown: string[] = []
  for (const tab of await tabs.getByRole("tab").all()) {
    const label = tab.locator("span.truncate")
    if ((await label.count()) > 0) shown.push((await label.textContent()) ?? "")
  }
  return shown.filter((label) => label !== "Cast")
}

for (const width of [1340, 390])
  test(`character tabs: names, versions only for look-alikes, only the open one expanded, at ${width}`, async ({
    page
  }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chatId}`)
    await openPanel(page, "Cast")
    const tabs = page.getByRole("tablist", { name: "Characters", exact: true })
    const people = tabs.getByRole("tab").filter({ hasNot: page.getByText("Cast", { exact: true }) })
    await expect(people).toHaveCount(labels.length)
    for (const [index, label] of labels.entries()) await expect(people.nth(index)).toHaveAccessibleName(label)
    // The character the persona shares a name with says its name only, though its version is "main".
    await expect(people.nth(0)).not.toContainText("·")
    await expect(people.nth(0)).toHaveAttribute("title", names[0]!)

    const strip = page.locator("[data-chat-panel-tabs]")
    let height: number | null = null
    for (let index = 0; index < labels.length; index++) {
      const open = people.nth(index)
      await open.click()
      await expect(open).toHaveAttribute("aria-selected", "true")
      // The names don't fit together: the open tab alone keeps its name.
      await expect.poll(() => expanded(tabs)).toEqual([labels[index]])
      // The persona, collapsed, is its portrait and its "you", without its name.
      const persona = people.nth(labels.length - 1)
      await expect(persona.getByText("you", { exact: true })).toBeVisible()
      if (index < labels.length - 1) await expect(persona.getByText(names[0]!, { exact: true })).toHaveClass(/sr-only/)
      // Nothing scrolls sideways, and selecting never changes the strip's height.
      expect(await tabs.evaluate((list) => list.scrollWidth - list.clientWidth)).toBeLessThanOrEqual(0)
      const box = await strip.boundingBox()
      height ??= box!.height
      expect(box!.height).toBe(height)
    }
    await expectLayout(page, info, `cast-tabs-names-${width}`, { scope: "[data-chat-panel-tabs]" })
    await page.screenshot({ path: info.outputPath(`cast-tabs-${width}.png`) })
  })
