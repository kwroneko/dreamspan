import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { ShellLibrary } from "@rp/shared/chatSetupApi.ts"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { panelTab } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "60" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
let data: ShellLibrary
const shots = resolve(process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-unit-e-screenshots"))
test.setTimeout(240_000)
test.beforeAll(async ({ browser }) => {
  mkdirSync(shots, { recursive: true })
  const page = await browser.newPage()
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const folder = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(folder)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toBeVisible({ timeout: 180_000 })
  data = await admin((api) => api.GetShellLibrary())
  const one = data.forks.find((f) => f.current && f.cast.length === 1)!
  const group = data.forks.find((f) => f.current && f.cast.length > 1)!
  await admin((api) =>
    Effect.all([
      api.SetChatPin({ chatId: one.chat.id, leaf: one.leaf, pinned: true }),
      api.SetChatPin({ chatId: group.chat.id, leaf: group.leaf, pinned: true })
    ])
  )
  data = await admin((api) => api.GetShellLibrary())
  await page.close()
})

for (const width of [1440, 390]) {
  test(`independent panels, crumbs, scoped pins and group forks at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(server().url)
    const pins = page.getByRole("main").getByRole("region", { name: "Pinned chats", exact: true })
    await pins.getByRole("button", { name: /Pinned chats/ }).click()
    await page.reload()
    await expect(pins.getByRole("button", { name: /^Open chat / })).toHaveCount(0)
    await pins.getByRole("button", { name: /Pinned chats/ }).click()
    await expect(pins.getByRole("button", { name: /^Open chat / })).toHaveCount(2)
    const character = data.cards.find((c) => c.card.chats > 0)!
    const latest = [...data.forks.filter((f) => f.joined.includes(character.card.entityId))].sort(
      (a, b) =>
        (b.activity.find((a) => a.entityId === character.card.entityId)?.at ?? -1) -
          (a.activity.find((a) => a.entityId === character.card.entityId)?.at ?? -1) || b.recentAt - a.recentAt
    )[0]!
    await page
      .getByRole("main")
      .getByRole("button", {
        name: `Open ${character.card.label}${character.card.subtitle ? ` · ${character.card.subtitle}` : ""}`,
        exact: true
      })
      .click()
    await expect(page).toHaveURL(new RegExp(`/chats/${latest.chat.id}`))
    await expect(page.getByRole("tab", { name: character.card.label, exact: true })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(new URL(page.url()).searchParams.get("slot")).toBe(
      latest.activity.find((a) => a.entityId === character.card.entityId)?.slot ?? null
    )
    if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    const openLeft = async () => {
      if (width === 390) await page.getByRole("button", { name: "Chats and menu" }).click()
    }
    await openLeft()
    const crumbs = page.getByRole("navigation", { name: "Chat breadcrumbs" })
    await expect(crumbs).toContainText(character.card.label)
    const scopedPins = data.forks.filter((f) => f.pinned && f.joined.includes(character.card.entityId))
    await expect(
      page
        .getByRole("region", { name: "Pinned chats", exact: true })
        .first()
        .getByRole("button", { name: /^Open chat / })
    ).toHaveCount(scopedPins.length)
    // The left panel's place is in the URL (owner, 2026-10-31); browsing it keeps the chat in the middle.
    const before = new URL(page.url()).pathname
    await crumbs.getByRole("button", { name: "All chats", exact: true }).click()
    await expect(crumbs).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).searchParams.get("character")).toBeNull()
    expect(new URL(page.url()).pathname).toBe(before)
    // Browsing the grid changes only the left panel until a character is picked.
    const left = page.getByRole("group", { name: "Left panel", exact: true })
    await left.getByRole("button", { name: "Characters", exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("side")).toBe("characters")
    expect(new URL(page.url()).pathname).toBe(before)
    await page
      .getByRole("button", {
        name: `Open ${character.card.label}${character.card.subtitle ? ` · ${character.card.subtitle}` : ""}`,
        exact: true
      })
      .click()
    if (width === 390) {
      // Same chat + a changed search still closes the left sheet when a character is picked.
      await expect(page.getByRole("button", { name: "Close the menu" })).toHaveCount(0)
      await page.getByRole("button", { name: "Close", exact: true }).click()
    }
    await page.goto(server().url)
    await page
      .getByRole("group", { name: "Show", exact: true })
      .getByRole("button", { name: "Groups", exact: true })
      .click()
    const group = data.forks.find((f) => f.cast.length > 1 && f.current)!
    await page
      .getByRole("main")
      .getByLabel("Groups", { exact: true })
      .getByRole("button", { name: `Open chat ${group.chatName}`, exact: true })
      .first()
      .click()
    await expect(page).toHaveURL(new RegExp(`/chats/${group.chat.id}`))
    // Current-fork URLs are canonicalized after the path loads. Wait before
    // opening phone sheets; neither the fork nor its temporary leaf stays in the URL.
    await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBeNull()
    await expect.poll(() => new URL(page.url()).searchParams.get("leaf")).toBeNull()
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    if (width === 390 && (await page.getByRole("button", { name: "Close", exact: true }).isVisible()))
      await page.getByRole("button", { name: "Close", exact: true }).click()
    await openLeft()
    await expect(crumbs).toContainText(group.name)
    await expect(page.getByRole("region", { name: "Pinned chats" }).first()).toContainText(group.name)
    await expect(page.getByRole("region", { name: "Latest branch", exact: true })).toContainText(group.name)
    if (width === 390) await page.getByRole("button", { name: "Close the menu", exact: true }).click()
    const appended = await admin((api) =>
      api.SendMessage({
        chatId: group.chat.id,
        parentSlotId: group.leaf,
        speakerEntityId: group.cast[0]!,
        branch: true,
        content: "Synthetic navigation regression: the pinned fork continues."
      })
    )
    // The chat header's ☆ (a phone's header leaves it to the chat lists' rows).
    const headerPin = page
      .getByRole("main")
      .locator("header")
      .getByRole("button", { name: `${group.pinned ? "Unpin" : "Pin"} ${group.name}`, exact: true })
    if (width === 390) await expect(headerPin).toBeHidden()
    else await expect(headerPin).toBeVisible()
    const newLeaf = await admin((api) =>
      Effect.gen(function* () {
        const forked = yield* api.SendMessage({
          chatId: group.chat.id,
          parentSlotId: group.leaf,
          speakerEntityId: group.cast[0]!,
          branch: true,
          content: "A separate synthetic fork."
        })
        if (forked._tag !== "Posted") throw new Error("unexpected queue")
        yield* api.SwitchBranch({ chatId: group.chat.id, slotId: forked.entry.slotId, index: 0 })
        return forked.entry.slotId
      })
    )
    if (appended._tag !== "Posted") throw new Error("unexpected queue")
    // A fork is opened by its id (`?fork=`); the tip names it.
    const forkEndingAt = (slotId: string) =>
      admin((api) => api.ListForks({ chatId: group.chat.id })).then(
        (forks) => forks.find((f) => f.tipSlotId === slotId)!.id
      )
    const newFork = await forkEndingAt(newLeaf)
    await page.goto(`${server().url}/chats/${group.chat.id}?fork=${newFork}`)
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    await expect(page.getByRole("button", { name: /switch branch/ })).toBeVisible()
    await expect(page.getByRole("button", { name: /not the latest/ })).toHaveCount(0)
    await page.goto(`${server().url}/chats/${group.chat.id}?fork=${await forkEndingAt(appended.entry.slotId)}`)
    await page.getByRole("button", { name: /not the latest/ }).click()
    await page.getByRole("button", { name: "Back to the latest branch", exact: true }).click()
    // The link names no fork: the chat's current one, which is where the newest branch went.
    await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBeNull()
    await expect(page.getByRole("button", { name: /not the latest/ })).toHaveCount(0)
    data = await admin((api) => api.GetShellLibrary())
  })

  for (const theme of ["light", "dark"]) {
    test(`walkthrough ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme as "light" | "dark" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.addInitScript((theme) => {
        localStorage.setItem("rp.theme", theme)
        document.documentElement.dataset.theme = theme
      }, theme)
      await page.goto(server().url)
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
        document.documentElement.classList.toggle("dark", theme === "dark")
      }, theme)
      const shoot = async (name: string) => {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value
        }, theme)
        await expect(page.locator("html")).toHaveCSS("color-scheme", theme)
        await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) })
      }
      await expect(page.getByRole("heading", { name: "Characters", exact: true })).toBeVisible()
      for (const [tab, name] of [
        ["All", "home"],
        ["With chats", "with-chats"],
        ["Never used", "never-used"],
        ["Groups", "groups"]
      ] as const) {
        await page
          .getByRole("group", { name: "Show", exact: true })
          .getByRole("button", { name: tab, exact: true })
          .click()
        await shoot(name)
      }
      const fork = data.forks.find((f) => f.current && f.cast.length > 1)!
      const card = fork.cast[0]!
      await page.goto(`${server().url}/chats/${fork.chat.id}?panel=card:${card}&forks=${fork.chat.id}`)
      // In a chat, the card's tab has the Cast row's actions, the full editor among them (f55e4e7).
      await expect(
        page
          .getByRole("tabpanel")
          .getByRole("button", { name: /^Open .+ in the full editor$/ })
          .first()
      ).toBeVisible()
      await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
      await shoot("chat-card")
      for (const tab of ["Cast", "This chat", "Lorebooks", "Notes", "Summaries"]) {
        await panelTab(page, tab)
        if (tab === "Notes")
          await expect(page.getByRole("region", { name: "This chat's notes", exact: true })).toBeVisible()
        await shoot(`panel-${tab.toLowerCase().replaceAll(" ", "-")}`)
      }
      if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
      else await page.getByRole("button", { name: "Close the panel", exact: true }).click()
      await shoot("chat")
      await page
        .locator("article")
        .getByRole("button", { name: /^View .+'s portrait$/ })
        .last()
        .click()
      await expect(page.getByRole("img", { name: /full portrait$/ })).toBeVisible()
      await shoot("portrait")
      await page.keyboard.press("Escape")
      // A phone's chat header replaces the app's bar: its ← opens the menu, which has the image settings.
      if (width === 390) await page.getByRole("button", { name: "Chats and menu" }).click()
      await page.getByRole("button", { name: "Image settings", exact: true }).first().click()
      await shoot("image-settings")
      await page.keyboard.press("Escape")
      await shoot("left-chats")
      await page
        .getByRole("group", { name: "Left panel", exact: true })
        .getByRole("button", { name: "Characters", exact: true })
        .click()
      await shoot("left-characters")
      if (width === 390) await page.getByRole("button", { name: "Close the menu" }).click()
      await page.goto(server().url)
      await page
        .getByRole("group", { name: "Show", exact: true })
        .getByRole("button", { name: "Never used", exact: true })
        .click()
      const unused = data.cards.find((c) => !c.card.chats)!
      await page
        .getByRole("main")
        .getByRole("button", {
          name: `Open ${unused.card.label}${unused.card.subtitle ? ` · ${unused.card.subtitle}` : ""}`,
          exact: true
        })
        .click()
      await expect(page.getByRole("link", { name: "Edit card", exact: true })).toBeVisible()
      await shoot("new-chat-card")
      if (width === 390) await page.getByRole("button", { name: "Close", exact: true }).click()
      else await page.getByRole("button", { name: "Close the panel", exact: true }).click()
      await shoot("new-chat")
      await page.getByRole("button", { name: `Show ${unused.card.name}'s card`, exact: true }).click()
      await expect(page.getByRole("link", { name: "Edit card", exact: true })).toBeVisible()
      await page.goto(`${server().url}/cards/${card}`)
      await expect(page.getByRole("heading", { name: "Definition", exact: true })).toBeVisible()
      await shoot("card-page")
      await page.goto(`${server().url}/groups/${fork.chat.id}`)
      await expect(page.getByRole("button", { name: "Rename group", exact: true })).toBeVisible()
      await shoot("group-page")
      await page.goto(`${server().url}/chats`)
      await expect(page.getByRole("main").getByRole("list", { name: "Chats", exact: true })).toBeVisible()
      await shoot("chats-page")
    })
  }
}
