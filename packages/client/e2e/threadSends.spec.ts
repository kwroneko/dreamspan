// Sending to several threads (spec/THREADS.md §6, TH4): the composer's "To this thread" chip
// in a thread, ticking another thread and whom the user writes as there, one send that posts a
// copy in each and a reply in each from its own messages, the header's "Also in" link to the
// other copy, "Save in both" beside "Save here", and the delete toast's offer to delete the
// other copy too. Synthetic chats only; the fake generator replies.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { nextReply } from "./support/strip.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "12" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

/**
 * Ash (the user's) with Mira "At the Lantern" and Wren "At the docks", threads from #3; Tobin, the
 * user's other voice, is in neither, so each thread's reply is its one character's.
 */
const seed = (suffix: string) =>
  admin((api) =>
    Effect.gen(function* () {
      if (process.env.READING_THREAD_DENSITY === "compact")
        yield* api.SetDisplayPrefs({ prefs: { chatDensity: "compact" } })
      const chat = yield* api.CreateChat({ title: `Harbor ${suffix}` })
      const card = (name: string) => api.CreateCard({ label: `Synthetic ${name}`, name })
      const [mira, tobin, wren, ash] = yield* Effect.all([card("Mira"), card("Tobin"), card("Wren"), card("Ash")])
      for (const c of [mira, tobin, wren, ash])
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: c.entityId } })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: null,
        change: { _tag: "PlayedByMe", entityIds: [ash.entityId as EntityId] }
      })
      const lines: ReadonlyArray<readonly [string, { readonly entityId: string }]> = [
        ["The ferry docks at dusk.", ash],
        ["Mira shoulders her pack.", mira],
        ["Tobin: Wren, check the docks. We'll take rooms at the Lantern.", tobin]
      ]
      let parent: SlotId | null = null
      let rowVersion = 0
      for (const [content, speaker] of lines) {
        const sent: {
          readonly _tag: string
          readonly entry?: { readonly slotId: SlotId; readonly rowVersion: number }
        } = yield* api.SendMessage({
          chatId: chat.id,
          forkId: chat.currentForkId!,
          parentSlotId: parent,
          branch: false,
          content,
          speakerEntityId: speaker.entityId as EntityId
        })
        if (sent._tag !== "Posted") throw new Error("Synthetic chat unexpectedly queued")
        parent = sent.entry!.slotId
        rowVersion = sent.entry!.rowVersion
      }
      const started = yield* api.StartThreads({
        chatId: chat.id,
        forkId: chat.currentForkId!,
        slotId: parent!,
        expectedRowVersion: rowVersion,
        threads: [
          { name: "At the Lantern", cast: [mira.entityId as EntityId], writesAs: null },
          { name: "At the docks", cast: [wren.entityId as EntityId], writesAs: null }
        ]
      })
      return { chatId: chat.id as ChatId, lantern: started.forkIds[0]!, docks: started.forkIds[1]! }
    })
  )

/** The texts and speakers' entity ids of branch `forkId`, oldest first. */
const texts = (chatId: ChatId, forkId: ForkId) =>
  admin((api) =>
    Effect.map(api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }), (page) =>
      page.entries.map((entry) => entry.version.content)
    )
  )

const open = async (page: Page, path: string, width: number, theme: "light" | "dark") => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
  await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}${path}`)
  await expect(page.getByTestId("composer")).toBeVisible()
}

const chip = (page: Page) => nextReply(page).getByRole("button", { name: /^To (this thread|\d threads)\. / })
const messages = (page: Page) => page.locator("article[data-slot]")
const composer = (page: Page) => page.getByLabel("Message", { exact: true })

for (const [width, theme] of [
  [390, "light"],
  [1440, "dark"]
] as const)
  test(`the composer's thread chip and its popover lay out at ${width} (${theme})`, async ({ page }, info) => {
    const { chatId } = await seed(`${width}`)
    await open(page, `/chats/${chatId}`, width, theme)
    await expect(chip(page)).toHaveAccessibleName("To this thread. Choose other threads that get this message")
    await expectLayout(page, info, `composer strip ${width} ${theme}`, { scope: '[data-testid="composer"]' })
    await chip(page).click()
    const popover = page.getByRole("dialog", { name: "Send to threads" })
    await popover.getByRole("checkbox", { name: "At the docks" }).click()
    await expect(popover.getByRole("combobox", { name: "Writes as, in “At the docks”" })).toContainText("As there")
    await expectLayout(page, info, `send to threads ${width} ${theme}`, { scope: '[role="dialog"]' })
  })

test("one send posts a copy and a reply in each thread ticked, linked, saved and deleted together", async ({
  page
}) => {
  const { chatId, lantern, docks } = await seed("send")
  await open(page, `/chats/${chatId}`, 1280, "light")

  // A thread that isn't one of these (a branch) is never offered; the other thread is.
  await chip(page).click()
  const popover = page.getByRole("dialog", { name: "Send to threads" })
  await expect(popover.getByRole("checkbox")).toHaveCount(1)
  await popover.getByRole("checkbox", { name: "At the docks" }).click()
  // In the docks the user writes as Tobin, here as Ash (the composer's choice).
  await popover.getByRole("combobox", { name: "Writes as, in “At the docks”" }).click()
  await page.getByRole("option", { name: "Tobin", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(chip(page)).toHaveAccessibleName("To 2 threads. Choose other threads that get this message")

  await composer(page).fill("The bells ring twice.")
  // Send says where it goes.
  await page.getByRole("button", { name: /^Send/ }).hover()
  await expect(page.getByText(/^Send as Ash here and in “At the docks”/)).toBeVisible()
  await page.keyboard.press("Enter")
  // Here: the copy, then a reply; the tick stays for the next message, until unticked.
  await expect(messages(page)).toHaveCount(5)
  await expect(page.getByText("generating", { exact: true })).toHaveCount(0)
  await expect(chip(page)).toHaveAccessibleName("To 2 threads. Choose other threads that get this message")
  const copy = messages(page).nth(3)
  await expect(copy).toContainText("The bells ring twice.")
  const also = copy.locator("[data-also-in]")
  await expect(also).toHaveText("Also in At the docks")

  // There: its own copy, as Tobin, and Wren's reply, from that thread's messages alone.
  await expect.poll(async () => (await texts(chatId, docks)).length).toBe(5)
  const there = await texts(chatId, docks)
  expect(there[3]).toBe("The bells ring twice.")
  expect((await texts(chatId, lantern)).length).toBe(5)

  // The link opens the copy in its thread, in this tab.
  await also.getByRole("link", { name: "At the docks" }).click()
  await expect(page).toHaveURL(new RegExp(`fork=${docks}`))
  await expect(page.getByRole("button", { name: /^Thread: At the docks,/ })).toBeVisible()
  const docksCopy = messages(page).nth(3)
  await expect(docksCopy.locator("header").first()).toContainText("Tobin")
  await expect(docksCopy.locator("[data-also-in]")).toHaveText("Also in At the Lantern")
  await expect(messages(page).nth(4).locator("header").first()).toContainText("Wren")

  // An edit offers "Save in both" beside "Save here", and amends the other copy too.
  await showActions(docksCopy)
  await docksCopy.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = docksCopy.getByRole("textbox").first()
  await editor.fill("The bells ring three times.")
  await expect(docksCopy.getByRole("button", { name: "Save here", exact: true })).toBeVisible()
  await docksCopy.getByRole("button", { name: "Save in both", exact: true }).click()
  await expect(page.getByText("Saved in “At the Lantern” too")).toBeVisible()
  await expect.poll(async () => (await texts(chatId, lantern))[3]).toBe("The bells ring three times.")
  await expect(messages(page).nth(3)).toContainText("The bells ring three times.")

  // Deleting it here offers deleting the other copy too.
  await showActions(messages(page).nth(3))
  await messages(page).nth(3).getByRole("button", { name: "Delete message", exact: true }).click()
  await page.getByRole("button", { name: "Delete the copy in “At the Lantern” too", exact: true }).click()
  await expect.poll(async () => (await texts(chatId, lantern)).includes("The bells ring three times.")).toBe(false)
  expect(await texts(chatId, docks)).not.toContain("The bells ring three times.")
})

// Reading-mode review: the same join/return and linked-message flows in Compact,
// without changing the normal default-density gate.
test.afterEach(async ({ page }, info) => {
  if (process.env.READING_THREAD_DENSITY !== "compact" || !process.env.SCREENSHOT_DIR || info.status !== "passed")
    return
  await page.screenshot({
    path: `${process.env.SCREENSHOT_DIR}/compact-${info.title.replace(/[^a-z0-9]+/gi, "-")}.png`
  })
})
