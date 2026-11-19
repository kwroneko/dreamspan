// Merging another chat into this one (spec/CHAT-MERGE.md §7): the ⋯ menu's and a message's
// entry points open one dialog, which says what comes in and shows what the model reads; the
// merge is one collapsible entry in the timeline, linking to its source; the chat's settings
// offer the layout once there's a merge. Synthetic chats only.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, ForkId, SlotId } from "@dreamspan/shared/chat.ts"
import { openPanel } from "./support/panel.ts"
import { messageMenu } from "./support/message.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "20" })
const shots = process.env.CHATMERGE_SHOTS

const seedChat = (api: Client, title: string, name: string, lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const chat = yield* api.CreateChat({ title })
    const card = yield* api.CreateCard({ label: `Synthetic ${name}`, name })
    yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
    let parent: SlotId | null = null
    const slots: Array<SlotId> = []
    for (const content of lines) {
      const sent: { readonly _tag: string; readonly entry?: { readonly slotId: SlotId } } = yield* api.SendMessage({
        chatId: chat.id,
        forkId: chat.currentForkId!,
        parentSlotId: parent,
        branch: false,
        content,
        speakerEntityId: card.entityId as EntityId
      })
      if (sent._tag !== "Posted") throw new Error("Synthetic chat unexpectedly queued")
      parent = sent.entry!.slotId
      slots.push(sent.entry!.slotId)
    }
    return { chatId: chat.id as ChatId, forkId: chat.currentForkId! as ForkId, slots }
  })

const seed = (suffix: string) =>
  asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const home = yield* seedChat(api, `Harbor ${suffix}`, "Mira", [
        "The lantern swings over the quay.",
        "Mira counts the crates twice.",
        "A bell rings from the harbor master's office."
      ])
      const away = yield* seedChat(api, `Docks ${suffix}`, "Kai", [
        "Kai climbs the crane at dusk.",
        "The tide comes in under the pier."
      ])
      return { home, away }
    })
  )

const open = async (page: Page, path: string, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${path}`)
  await expect(page.getByTestId("composer")).toBeVisible()
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Merge a chat into this one", exact: true })
const shoot = async (page: Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false })
}
const pickSource = async (page: Page, title: string) => {
  await dialog(page).getByRole("searchbox", { name: "Chat to merge" }).fill(title)
  await dialog(page).getByRole("list", { name: "Chats" }).getByRole("button", { name: title, exact: true }).click()
  await expect(dialog(page).getByTestId("merge-relation")).toBeVisible()
}

for (const [width, theme] of [
  [1440, "light"],
  [1440, "dark"],
  [390, "light"],
  [390, "dark"]
] as const)
  test(`merging from the chat menu: what comes in, the merge, the timeline entry (${width} ${theme})`, async ({
    page
  }) => {
    const suffix = `${width}-${theme}`
    const { home, away } = await seed(suffix)
    await open(page, `/chats/${home.chatId}`, width, theme)
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    const item = page.getByRole("menuitem", { name: "Merge another chat…", exact: true })
    await item.hover()
    // Beside the menu on a wide screen, under the item's label on a narrow one.
    await expect(
      width < 640
        ? item.getByText("Brings another chat's messages into this one, after the newest message.")
        : page.locator("[data-explanation]")
    ).toHaveText("Brings another chat's messages into this one, after the newest message.")
    await item.click()
    await expect(dialog(page)).toBeVisible()
    await pickSource(page, `Docks ${suffix}`)
    await expect(dialog(page).getByTestId("merge-relation")).toHaveText("Merges 2 messages")
    await expect(dialog(page).getByText("+Kai", { exact: true })).toBeVisible()
    await expect(dialog(page).getByLabel("Title", { exact: true })).toHaveValue(`Docks ${suffix}`)
    await dialog(page).getByText("What the model reads", { exact: true }).click()
    const section = dialog(page).getByTestId("merge-section")
    await expect(section).toContainText(`Meanwhile, in parallel with what follows: Docks ${suffix}, with Kai.`)
    await expect(section).toContainText("Kai: Kai climbs the crane at dusk.")
    await expect(section).toContainText(`[Here “Docks ${suffix}” joins this chat.]`)
    await shoot(page, `dialog-${width}-${theme}`)
    await dialog(page).getByRole("button", { name: "Merge", exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)

    const row = page.getByRole("article", { name: `Merged chat “Docks ${suffix}”`, exact: true })
    await expect(row).toBeVisible()
    const toggle = row.getByRole("button", { name: `Merged “Docks ${suffix}” · 2 messages`, exact: true })
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.click()
    await expect(row.getByRole("list", { name: `Messages of “Docks ${suffix}”` })).toContainText(
      "The tide comes in under the pier."
    )
    await expect(row.getByRole("link", { name: `Open “Docks ${suffix}”`, exact: true })).toHaveAttribute(
      "href",
      new RegExp(`/chats/${away.chatId}`)
    )
    await shoot(page, `timeline-${width}-${theme}`)

    // Stored: the join, the cast union, nothing written to the source.
    const after = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const path = yield* api.ReadPath({
          chatId: home.chatId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 50
        })
        const source = yield* api.ReadPath({
          chatId: away.chatId,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 50
        })
        return { origins: path.entries.map((e) => e.version.origin), source: source.entries.length }
      })
    )
    expect(after.origins.at(-1)).toBe("merge")
    expect(after.source).toBe(2)

    // The chat's settings offer the layout now.
    const panel = await openPanel(page, "This chat")
    const layouts = panel.getByRole("radiogroup", { name: "Merged chats" })
    await expect(layouts.getByRole("radio", { name: /^Parallel span/ })).toBeChecked()
    await layouts.getByRole("radio", { name: /^Block at the join/ }).click()
    await expect(layouts.getByRole("radio", { name: /^Block at the join/ })).toBeChecked()
    await shoot(page, `settings-${width}-${theme}`)
  })

for (const [width, theme] of [
  [1440, "light"],
  [1440, "dark"],
  [390, "light"],
  [390, "dark"]
] as const)
  test(`merging another chat with each character keeping its own past (${width} ${theme})`, async ({ page }) => {
    const suffix = `own-${width}-${theme}`
    const { home } = await seed(suffix)
    await open(page, `/chats/${home.chatId}`, width, theme)
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
    await pickSource(page, `Docks ${suffix}`)
    const choice = dialog(page).getByRole("radiogroup", { name: "How the characters see it" })
    await expect(choice.getByRole("radio", { name: /^Everyone reads both chats/ })).toBeChecked()
    await choice.getByRole("radio", { name: /^Each character keeps its own chat's past/ }).click()
    await expect(choice.getByRole("radio", { name: /^Each character keeps its own chat's past/ })).toBeChecked()
    await expect(choice).toContainText("Everyone reads what follows the merge. A narrator reads both.")
    await dialog(page).getByText("What the model reads", { exact: true }).click()
    const reader = dialog(page).getByRole("combobox", { name: "For" })
    const section = dialog(page).getByTestId("merge-section")
    await reader.click()
    await page.getByRole("option", { name: /^Kai/ }).click()
    await expect(section).toContainText("Kai: Kai climbs the crane at dusk.")
    await expect(section).toContainText("[Of this chat before the merge, only what Kai was there for]")
    await reader.click()
    await page.getByRole("option", { name: /^Mira/ }).click()
    await expect(section).toContainText(`[Nothing of “Docks ${suffix}”: Mira wasn't there.]`)
    await expect(section).not.toContainText("Kai climbs the crane")
    await shoot(page, `own-past-dialog-${width}-${theme}`)
    await dialog(page).getByRole("button", { name: "Merge", exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    const row = page.locator("article[data-merge]").last()
    await expect(row).toBeVisible()
    // One user click must survive the merge's pending state/metadata updates.
    await row.getByRole("button", { name: /^Merged “/ }).click()
    await expect(row.getByRole("list", { name: /^Messages of / })).toBeVisible()
    await expect(row.getByRole("button", { name: /^Merged “/ })).toHaveAttribute("aria-expanded", "true")
    const stored = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      api.ReadPath({ chatId: home.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
    )
    expect(stored.entries.at(-1)?.version.origin).toBe("merge")
  })

for (const [width, theme] of [
  [1440, "light"],
  [1440, "dark"],
  [390, "light"],
  [390, "dark"]
] as const)
  test(`merging another chat brings only the notes ticked (${width} ${theme})`, async ({ page }) => {
    const suffix = `notes-${width}-${theme}`
    const { home, away } = await seed(suffix)
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        for (const [title, content] of [
          ["Harbor curfew", "No boats leave after the second bell."],
          ["Gull omens", '<img src=x onerror="globalThis.mergeNoteInjected=true"> Three gulls mean a storm.']
        ] as const) {
          const note = yield* api.CreateChatNote({ chatId: away.chatId, forkId: away.forkId, title, content })
          yield* api.ChangeCast({
            chatId: away.chatId,
            slotId: away.slots.at(-1)!,
            change: { _tag: "Note", entityId: note.entityId, active: true }
          })
        }
      })
    )
    await open(page, `/chats/${home.chatId}`, width, theme)
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
    await pickSource(page, `Docks ${suffix}`)
    const notes = dialog(page).getByRole("region", { name: "Notes to bring" })
    await expect(notes).toContainText(`Notes on in “Docks ${suffix}”.`)
    const curfew = notes.getByRole("checkbox", { name: "Harbor curfew" })
    const omens = notes.getByRole("checkbox", { name: "Gull omens" })
    await expect(curfew).not.toBeChecked()
    await expect(omens).not.toBeChecked()
    await expect(notes).toContainText("Every reply reads it, this chat's characters' too.")
    await expect(notes).toContainText('<img src=x onerror="globalThis.mergeNoteInjected=true">')
    await expect(notes.locator("img, script")).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { mergeNoteInjected?: boolean }).mergeNoteInjected)
    ).toBeUndefined()
    await expect(notes).toContainText("“No boats leave after the second bell.”")
    // Its hint is the tooltip on hover and focus, and the box's description.
    await expect(curfew).toHaveAccessibleDescription(
      /^Copies this note into this chat\. The other chat keeps its own\./
    )
    await curfew.click()
    await expect(curfew).toBeChecked()
    await dialog(page)
      .getByRole("radio", { name: /^Each character keeps its own chat's past/ })
      .click()
    await page.reload()
    await expect(dialog(page)).toBeVisible()
    await expect(curfew).toBeChecked()
    await expect(omens).not.toBeChecked()
    await expect(dialog(page).getByRole("radio", { name: /^Each character keeps its own chat's past/ })).toBeChecked()
    await shoot(page, `notes-dialog-${width}-${theme}`)
    await dialog(page).getByRole("button", { name: "Merge", exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole("article", { name: `Merged chat “Docks ${suffix}”`, exact: true })).toBeVisible()
    const listed = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const here = yield* api.ListChatNotes({ chatId: home.chatId, forkId: home.forkId, slotId: null })
        const there = yield* api.ListChatNotes({ chatId: away.chatId, forkId: away.forkId, slotId: null })
        return {
          here: here.map((n) => String(n.doc["title"])),
          there: there.map((n) => String(n.doc["title"]))
        }
      })
    )
    expect(listed.here).toContain("Harbor curfew")
    expect(listed.here).not.toContain("Gull omens")
    expect(listed.there).toEqual(expect.arrayContaining(["Harbor curfew", "Gull omens"]))
  })

test("a message's Merge a chat here… merges after that message", async ({ page }) => {
  const { home } = await seed("here")
  await open(page, `/chats/${home.chatId}`, 1440, "light")
  const second = page.getByRole("article").filter({ hasText: "Mira counts the crates twice." })
  await messageMenu(second, "Merge a chat here…")
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole("combobox", { name: "Merge after" })).toContainText("After #2")
  await pickSource(page, "Docks here")
  await expect(dialog(page).getByRole("combobox", { name: "It ran alongside" })).toBeVisible()
  await dialog(page).getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  const path = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ReadPath({ chatId: home.chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 })
  )
  expect(path.entries.map((e) => e.version.origin === "merge")).toEqual([false, false, true, false])
  // A merge's entry offers only what makes sense for it.
  const row = page.getByRole("article", { name: "Merged chat “Docks here”", exact: true })
  await row.hover()
  await row.getByRole("button", { name: "More actions" }).click()
  const menu = page.getByRole("menu", { name: "More actions" })
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: /^Edit/ })).toHaveCount(0)
  await expect(menu.getByRole("menuitem", { name: /^Merge a chat here/ })).toHaveCount(0)
})

test("the dialog says why a merge can't be made, and Cancel changes nothing", async ({ page }) => {
  const { home } = await seed("refused")
  await open(page, `/chats/${home.chatId}`, 1440, "light")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
  await pickSource(page, "Docks refused")
  await dialog(page).getByRole("button", { name: "Merge", exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  // Merged already: nothing new to bring.
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
  await dialog(page).getByRole("searchbox", { name: "Chat to merge" }).fill("Docks refused")
  await dialog(page).getByRole("list", { name: "Chats" }).getByRole("button", { name: "Docks refused" }).click()
  await expect(dialog(page).getByText(/Nothing new in “Docks refused”/)).toBeVisible()
  await expect(dialog(page).getByRole("button", { name: "Merge", exact: true })).toBeDisabled()
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
})

test("a branch made its own chat is listed under its own name, and so is the chat it came from", async ({ page }) => {
  const seeded = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const home = yield* seedChat(api, "Quay split", "Mira", [
        "The lantern swings over the quay.",
        "Mira counts the crates twice.",
        "A bell rings from the harbor master's office."
      ])
      const { fork } = yield* api.CreateFork({ chatId: home.chatId, fromForkId: home.forkId, atSlotId: home.slots[0]! })
      let parent: SlotId = home.slots[0]!
      for (const content of ["Fog rolls in over the other quay.", "Nobody rings the bell tonight."]) {
        const sent: { readonly _tag: string; readonly entry?: { readonly slotId: SlotId } } = yield* api.SendMessage({
          chatId: home.chatId,
          forkId: fork.id,
          parentSlotId: parent,
          branch: false,
          content
        })
        parent = sent.entry!.slotId
      }
      yield* api.SetSplitChat({ forkId: fork.id, split: true, title: { name: "Foggy night", expectedName: null } })
      return { ...home, split: fork.id as ForkId }
    })
  )
  const merge = async (search: string, title: string, relation: string) => {
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
    await dialog(page).getByRole("searchbox", { name: "Chat to merge" }).fill(search)
    const chats = dialog(page).getByRole("list", { name: "Chats" })
    await expect(chats.getByRole("button", { name: title, exact: true })).toBeVisible()
    await chats.getByRole("button", { name: title, exact: true }).click()
    await expect(dialog(page).getByTestId("merge-relation")).toHaveText(relation)
    await expect(dialog(page).getByRole("textbox", { name: "Title" })).toHaveValue(title)
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click()
  }
  // From the chat it came from: the split-off chat, found by its own name.
  await open(page, `/chats/${seeded.chatId}?fork=${seeded.forkId}`, 1440, "light")
  await merge("Foggy", "Foggy night", "Shares #1–1 · merges 2 messages from #2")
  // From the split-off chat: the chat it came from, by its name, and not as "This chat".
  await page.goto(`${server().url}/chats/${seeded.chatId}?fork=${seeded.split}`)
  await expect(page.getByTestId("composer")).toBeVisible()
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Merge another chat…", exact: true }).click()
  await dialog(page).getByRole("searchbox", { name: "Chat to merge" }).fill("Quay split")
  const original = dialog(page).getByRole("list", { name: "Chats" }).getByRole("button", { name: "Quay split" })
  await expect(original).toHaveText("Quay split")
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click()
  await merge("Quay split", "Quay split", "Shares #1–1 · merges 2 messages from #2")
})
