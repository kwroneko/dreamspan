// Chats with a cast member leave the viewed chat/fork in place. Synthetic fixtures only.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { hideAppNavigation, showAppNavigation } from "./support/appMenu.ts"
import { expectLayout } from "./support/layoutAudit.ts"

test.setTimeout(120_000)
const server = serverPerFile(withAdmin)
let group = ""
let solo = ""
let mira = ""
let miraRef = ""
let persona = ""
let personaRef = ""
let unusedRef = ""
let original = ""
let secondary = ""
let userId = ""

test.beforeAll(async () => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      userId = (yield* api.Whoami()).id
      const first = yield* api.CreateCard({ label: "Mira", name: "Mira" })
      const other = yield* api.CreateCard({ label: "Wren", name: "Wren" })
      const me = yield* api.CreateCard({ label: "Rowan", name: "Rowan" })
      unusedRef = (yield* api.CreateCard({ label: "Unused", name: "Unused" })).id
      mira = first.entityId
      miraRef = first.id
      persona = me.entityId
      personaRef = me.id
      yield* api.SetPersona({ entityId: me.entityId, persona: true })
      const started = yield* api.StartChat({
        cards: [first.entityId, other.entityId],
        persona: me.entityId,
        greeting: null,
        first: { _tag: "Send", content: "The harbor lights are on.", speakerEntityId: me.entityId }
      })
      group = started.chat.id
      yield* api.RenameChat({ chatId: started.chat.id, name: "Harbor companions" })
      const fork = (yield* api.ListForks({ chatId: started.chat.id }))[0]!
      original = fork.id
      secondary = (yield* api.CreateFork({ chatId: started.chat.id, fromForkId: fork.id, atSlotId: fork.tipSlotId }))
        .fork.id
      yield* api.NameFork({ forkId: secondary as never, name: "North quay" })
      const single = yield* api.StartChat({
        cards: [first.entityId],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "A quiet watch.", speakerEntityId: first.entityId }
      })
      solo = single.chat.id
      yield* api.RenameChat({ chatId: single.chat.id, name: "Quiet watch" })
    })
  )
})

const navigation = (page: Page, width: number) =>
  width >= 1024
    ? page.getByRole("complementary", { name: "Sidebar", exact: true })
    : page.locator("[data-layout-overlay='Mobile navigation drawer covers the page']")
const branches = (nav: Locator) => nav.getByRole("region", { name: "Branches of the open chat" })
const upper = (nav: Locator) => nav.locator("[data-shell-list]")
const selected = (root: Locator, chat = group, fork?: string) =>
  root.locator(`[data-chat-id="${chat}"]${fork ? `[data-fork-id="${fork}"]` : ""}[aria-current="page"]`)
const showNavigation = async (page: Page) => {
  await expect(page.getByRole("main").getByRole("heading").first()).toBeVisible()
  await showAppNavigation(page)
}
const scope = (page: Page) => new URL(page.url()).searchParams.get("character")
const assertSelection = async (page: Page, nav: Locator) => {
  expect(new URL(page.url()).pathname).toBe(`/chats/${group}`)
  expect(new URL(page.url()).searchParams.get("fork")).toBe(secondary)
  await expect(selected(upper(nav))).toHaveCount(1)
  await expect(selected(branches(nav), group, secondary)).toHaveCount(1)
  await expect(selected(branches(nav), group, original)).toHaveCount(0)
}

for (const width of [1440, 390]) {
  test(`cast and header links retain the current secondary branch, history and scope (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${group}?fork=${secondary}&side=characters&sideQ=No match`)
    await openPanel(page, "Cast")
    await page.getByRole("button", { name: "More for Mira", exact: true }).click()
    const action = page.getByRole("button", { name: "Chats with Mira", exact: true })
    await expect(action).toBeVisible()
    // The new entry is immediately after Write as.
    expect(
      await action.evaluate((el) =>
        [...el.parentElement!.querySelectorAll("button")].slice(0, 2).map((b) => b.textContent)
      )
    ).toEqual(["Write as Mira", "Chats with Mira"])
    await action.click()
    const nav = navigation(page, width)
    await expect(nav).toBeVisible()
    await expect.poll(() => scope(page)).toBe(mira)
    await expect(nav.getByRole("button", { name: "Chats", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(nav.getByRole("navigation", { name: "Chat breadcrumbs" })).toContainText("Mira")
    await assertSelection(page, nav)
    await expect(nav.getByLabel("Find a chat")).toHaveValue("")
    await nav.getByRole("button", { name: "All chats", exact: true }).click()
    await expect.poll(() => scope(page)).toBe(null)
    await assertSelection(page, nav)
    await page.goBack()
    await showNavigation(page)
    await expect.poll(() => scope(page)).toBe(mira)
    await assertSelection(page, nav)
    await page.goForward()
    await showNavigation(page)
    await expect.poll(() => scope(page)).toBe(null)
    await page.goBack()
    await page.reload()
    await showNavigation(page)
    await assertSelection(page, nav)
    await expect.poll(() => scope(page)).toBe(mira)

    // Picking a different branch updates both selections, including on the phone drawer.
    await branches(nav).locator(`[data-fork-id="${original}"]`).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(original)
    await showNavigation(page)
    await expect(selected(upper(nav))).toHaveCount(1)
    await expect(selected(branches(nav), group, original)).toHaveCount(1)
    await branches(nav).locator(`[data-fork-id="${secondary}"]`).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(secondary)
    await showNavigation(page)
    await assertSelection(page, nav)

    // A filter can clear the upper selection without changing the lower branch viewer.
    await nav.getByLabel("Find a chat").fill("No matching chat")
    await expect(upper(nav).locator('[aria-current="page"]')).toHaveCount(0)
    await expect(selected(branches(nav), group, secondary)).toHaveCount(1)
    await nav.getByLabel("Find a chat").fill("")
    await assertSelection(page, nav)
    await hideAppNavigation(page)

    if (width >= 1024) await nav.getByRole("button", { name: "Hide the sidebar", exact: true }).click()
    await openPanel(page, "Mira")
    await page.locator("[data-card-header]").getByRole("link", { name: "2 chats", exact: true }).click()
    await expect(nav).toBeVisible()
    await expect.poll(() => scope(page)).toBe(mira)
    await assertSelection(page, nav)
    await hideAppNavigation(page)
    await openPanel(page, "Cast")
    await page.getByRole("button", { name: "More for Rowan", exact: true }).click()
    await page.getByRole("button", { name: "Chats as Rowan", exact: true }).click()
    await expect(nav).toBeVisible()
    await expect.poll(() => scope(page)).toBe(persona)
    await assertSelection(page, nav)
    await hideAppNavigation(page)
    await openPanel(page, "Rowan")
    await page.locator("[data-card-header]").getByRole("link", { name: "1 chat", exact: true }).click()
    await expect(nav).toBeVisible()
    await assertSelection(page, nav)
    await branches(nav).getByRole("button", { name: "Pin North quay", exact: true }).click()
    await expect(
      selected(nav.getByRole("region", { name: "Pinned chats", exact: true }), group, secondary)
    ).toHaveCount(1)
    await branches(nav).getByRole("button", { name: "Unpin North quay", exact: true }).click()
  })

  test(`divider drag, keyboard, limits, reset and reload (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${group}?fork=${secondary}`)
    await showNavigation(page)
    const nav = navigation(page, width)
    const handle = nav.getByRole("separator", { name: "Resize chats and branches", exact: true })
    await expect(handle).toBeVisible()
    const value = async () => Number(await handle.getAttribute("aria-valuenow"))
    const initial = await value()
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 45, { steps: 8 })
    await page.mouse.up()
    await expect.poll(value).toBe(initial + 45)
    await handle.press("ArrowDown")
    await expect.poll(value).toBe(initial + 35)
    await handle.press("Shift+ArrowUp")
    const enlarged = Math.min(initial + 75, Number(await handle.getAttribute("aria-valuemax")))
    await expect.poll(value).toBe(enlarged)
    await page.reload()
    await showNavigation(page)
    await expect.poll(value).toBe(enlarged)
    expect(await page.evaluate((id) => localStorage.getItem(`rp.branchHeight.${id}`), userId)).toBe(String(enlarged))
    await handle.press("Home")
    expect(await value()).toBe(Number(await handle.getAttribute("aria-valuemin")))
    await handle.press("End")
    expect(await value()).toBe(Number(await handle.getAttribute("aria-valuemax")))
    expect((await upper(nav).boundingBox())!.height).toBeGreaterThanOrEqual(80)
    expect((await branches(nav).boundingBox())!.height).toBeGreaterThanOrEqual(112)
    await handle.dblclick()
    await expect.poll(value).toBe(initial)
    await page.reload()
    await showNavigation(page)
    await expect.poll(value).toBe(initial)
  })

  test(`editor, card page, persona and unused card links (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    for (const [path, text, entity] of [
      [`/library/${miraRef}`, "2 chats", mira],
      [`/cards/${mira}`, "2 chats", mira],
      [`/library/${personaRef}`, "1 chat", persona]
    ] as const) {
      await page.goto(`${server().url}${path}`)
      await page.getByRole("main").getByRole("link", { name: text, exact: true }).click()
      const nav = navigation(page, width)
      await expect(nav).toBeVisible()
      await expect.poll(() => scope(page)).toBe(entity)
      expect(new URL(page.url()).pathname).toBe(path)
      await expect(nav.getByRole("button", { name: "All chats", exact: true })).toBeVisible()
    }
    await page.goto(`${server().url}/library/${unusedRef}`)
    await expect(page.getByRole("heading", { name: "Unused", exact: true })).toBeVisible()
    await expect(page.locator("[data-card-header]").getByRole("link", { name: /chats?$/ })).toHaveCount(0)
    // A single-branch chat still has the branch viewer and its selected branch.
    await page.goto(`${server().url}/chats/${solo}`)
    await showNavigation(page)
    await expect(selected(branches(navigation(page, width)), solo)).toHaveCount(1)
  })

  test(`layout audit: left column and card header (${width})`, async ({ page }, info) => {
    test.skip(!process.env.LAYOUT_AUDIT, "opt-in geometry audit")
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const work = process.env.LAYOUT_AUDIT_WORK!
    mkdirSync(work, { recursive: true })
    const findings: unknown[] = []
    const audit = async (surface: string) => {
      const violations = await expectLayout(page, info, surface)
      findings.push({ surface, violations })
      await page.screenshot({ path: join(work, `${width}-${surface}.png`) })
      writeFileSync(join(work, `chatswith-findings-${width}.json`), JSON.stringify(findings, null, 2))
    }
    await page.goto(`${server().url}/chats/${group}?fork=${secondary}&character=${mira}`)
    await showNavigation(page)
    await audit("left-column")
    await hideAppNavigation(page)
    await openPanel(page, "Mira")
    await expect(page.locator("[data-card-header]").getByRole("link", { name: "2 chats", exact: true })).toBeVisible()
    await audit("card-header")
  })
}
