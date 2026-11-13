// Parallel threads in the client (spec/THREADS.md §5.1, §13, TH3): start them from the ⋯ menu
// at the newest message and from a message's menu at an earlier one (the dialog says what
// happens to the messages after it), see them as threads, never as branches, in the header,
// the timeline and the left panel, switch by link and in a new tab, rename, Undo and restore
// from the bin, a second tab showing a thread that went, and the note editor's "Also change
// it in …". Synthetic chats only; no model is asked anything.
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { ChatId, EntityId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { messageMenu } from "./support/message.ts"
import { openPanel } from "./support/panel.ts"
import { saveRevision } from "./support/saveRevision.ts"
import { asUser, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let login: { readonly url: string; readonly cookie: string } | null = null
const admin = async <A>(use: Parameters<typeof asUser<A>>[3]) => {
  const target = server()
  if (login?.url !== target.url)
    login = { url: target.url, cookie: await loginCookie(target, ADMIN.handle, ADMIN.password) }
  return withCookie(target, login.cookie, use)
}

/** Ash (the user's) at the market with Mira, Tobin and Wren; a side branch at #4; six messages on the main one. */
const seed = (suffix: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: `Market ${suffix}` })
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
        ["The market closes at dusk.", ash],
        ["Mira counts the last crates.", mira],
        ["Tobin waves the cart on.", tobin],
        ["Wren listens at the gate.", wren],
        ["Mira points at the harbor.", mira],
        ["Tobin: Wren, find out whether the Gull has docked. We'll take rooms at the Lantern.", tobin]
      ]
      const slots: Array<SlotId> = []
      let side: ForkId | null = null
      for (const [index, [content, speaker]] of lines.entries()) {
        // The side branch, made at #4 before the last messages, so the main branch stays the one the chat opens on.
        if (index === 4) {
          const made = yield* api.CreateFork({
            chatId: chat.id,
            fromForkId: chat.currentForkId!,
            atSlotId: slots[3]!,
            name: "Side path"
          })
          side = made.fork.id as ForkId
        }
        const sent: { readonly _tag: string; readonly entry?: { readonly slotId: SlotId } } = yield* api.SendMessage({
          chatId: chat.id,
          forkId: chat.currentForkId!,
          parentSlotId: slots.at(-1) ?? null,
          branch: false,
          content,
          speakerEntityId: speaker.entityId as EntityId
        })
        if (sent._tag !== "Posted") throw new Error("Synthetic chat unexpectedly queued")
        slots.push(sent.entry!.slotId)
      }
      return {
        chatId: chat.id as ChatId,
        forkId: chat.currentForkId! as ForkId,
        side: side!,
        slots,
        wren: wren.entityId as EntityId
      }
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

const startDialog = (page: Page, from: number) =>
  page.getByRole("dialog", { name: `Threads from #${from}`, exact: true })
const trigger = (page: Page, kind: "Thread" | "Branch", name: string) =>
  page.getByRole("button", { name: new RegExp(`^${kind}: ${name},`) })
const branchMenu = (page: Page) => page.getByRole("dialog", { name: "Branches of this chat" })
const timelineRow = (page: Page) => page.locator("[data-threads-row]")

/** Moves Wren from This branch to the new thread and names it. */
const moveWren = async (page: Page, from: number, name: string) => {
  const dialog = startDialog(page, from)
  await expect(dialog).toBeVisible()
  const first = dialog.locator('[data-thread-row="0"]')
  const second = dialog.locator('[data-thread-row="1"]')
  await expect(first.getByRole("button", { name: "Wren", exact: true })).toHaveAttribute("aria-pressed", "true")
  // Nobody's in the new thread yet: Start says why it can't.
  await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeDisabled()
  await first.getByRole("button", { name: "Wren", exact: true }).click()
  await second.getByRole("button", { name: "Wren", exact: true }).click()
  await expect(second.getByRole("textbox", { name: "Name" })).toHaveAttribute("placeholder", "Wren")
  await second.getByRole("textbox", { name: "Name" }).fill(name)
  // Writes as: none of the user's cards and no narrator in it, so its character.
  await expect(second.getByRole("combobox", { name: "Writes as" })).toContainText("Wren")
  await expect(first.getByRole("combobox", { name: "Writes as" })).toContainText("As now")
  return dialog
}

/** RPC requests the page sends, by tag, from now on. */
const recordRequests = (page: Page) => {
  const sent: Array<string> = []
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      for (const line of payload.toString().split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { _tag: string; tag: string }
        if (message._tag === "Request") sent.push(message.tag)
      }
    })
  )
  return sent
}

/** A lifecycle write may refresh each view, then its reads must stop. */
const expectSettled = async (page: Page, sent: ReadonlyArray<string>, label: string, from = 0) => {
  await page.waitForTimeout(1000)
  const settled = sent.length
  for (const tag of ["ReadPath", "GetChat", "ListForks", "ThreadsOf"])
    expect(sent.slice(from).filter((request) => request === tag).length, `${label}: ${tag}`).toBeLessThanOrEqual(8)
  await page.waitForTimeout(1000)
  expect(sent.length - settled, `${label}: more requests: ${sent.slice(settled).join(", ")}`).toBeLessThanOrEqual(2)
}

for (const [width, theme] of [
  [1440, "light"],
  [1440, "dark"],
  [390, "light"],
  [390, "dark"]
] as const)
  test(`threads at the newest message: start, see, switch, rename, a second tab, Undo and restore (${width} ${theme})`, async ({
    page,
    context
  }, info) => {
    test.setTimeout(180_000)
    const phone = width === 390
    const suffix = `${width}-${theme}`
    const chat = await seed(suffix)
    const sent = recordRequests(page)
    await open(page, `/chats/${chat.chatId}`, width, theme)

    // A sibling view is already open while this tab starts threads.
    const sibling = await context.newPage()
    const siblingSent = recordRequests(sibling)
    await open(sibling, `/chats/${chat.chatId}?fork=${chat.side}`, width, theme)
    await expectSettled(sibling, siblingSent, "initial sibling")
    const startBefore = sent.length
    const siblingStart = siblingSent.length

    // ⋯ → Start parallel threads…, at the newest message: nothing said about later messages.
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    await page.getByRole("menuitem", { name: "Start parallel threads…", exact: true }).click()
    const dialog = await moveWren(page, 6, "At the docks")
    await expect(dialog.locator("[data-thread-played]")).toHaveCount(0)
    await expectLayout(page, info, `threads-dialog-${suffix}`, { scope: '[role="dialog"]' })
    await dialog.getByRole("button", { name: "Start", exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // The user stays where they were; the toast offers the new thread and Undo.
    const toast = page.locator("[data-toast]").filter({ hasText: "Threads started" })
    await expect(toast).toBeVisible()
    await expect(toast.getByRole("button", { name: "Open “At the docks”", exact: true })).toBeVisible()
    // The tab keeps showing this branch: the URL pins it, as it pins any branch shown.
    expect(new URL(page.url()).searchParams.get("fork") ?? chat.forkId).toBe(chat.forkId)

    // The header names the thread; the timeline marks where they part, after #6.
    await expect(trigger(page, "Thread", "Mira and Tobin")).toBeVisible()
    const row = timelineRow(page)
    await expect(row).toContainText("Parallel threads from here:")
    await expect(row).toContainText("Mira and Tobin (this one)")
    await expect(row.getByRole("link", { name: "At the docks", exact: true })).toBeVisible()
    await expectLayout(page, info, `threads-header-${suffix}`, { scope: "header" })
    await expectLayout(page, info, `threads-timeline-row-${suffix}`, { scope: "[data-threads-row]" })

    await expectSettled(page, sent, "Start", startBefore)
    await expectSettled(sibling, siblingSent, "Start in sibling", siblingStart)
    await sibling.close()

    // The branch control: Threads first, then the branches, never the other thread among them.
    await trigger(page, "Thread", "Mira and Tobin").click()
    const menu = branchMenu(page)
    await expect(menu).toBeVisible()
    const threads = menu.locator("[data-threads-section]")
    await expect(threads).toContainText("Threads from #6")
    await expect(threads.locator('[data-thread-row="0"]')).toContainText("this one")
    await expect(threads.locator('[data-thread-row="1"]')).toContainText("At the docks")
    const branches = menu.getByRole("list", { name: "Branches" })
    await expect(branches).toContainText("Side path")
    await expect(branches.getByRole("listitem")).toHaveCount(2)
    await expectLayout(page, info, `threads-${phone ? "sheet" : "popover"}-${suffix}`, { scope: '[role="dialog"]' })

    // Rename the docks there: every place that names it follows.
    const docksRow = threads.locator('[data-thread-row="1"]')
    await docksRow.getByRole("link").click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: "Open in a new browser tab", exact: true })).toBeVisible()
    await expectLayout(page, info, `threads-context-menu-${suffix}`, { scope: '[role="menu"]' })
    await page.keyboard.press("Escape")
    await docksRow.hover()
    await docksRow.getByRole("button", { name: "Rename At the docks", exact: true }).click()
    await docksRow.getByRole("textbox", { name: "Name of thread At the docks" }).fill("Docks")
    await docksRow.getByRole("textbox", { name: "Name of thread At the docks" }).press("Enter")
    // Saved once the field closes; an Escape before that would cancel the rename instead.
    await expect(docksRow.getByRole("textbox")).toHaveCount(0)
    await expect(docksRow).toContainText("Docks")
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(row.getByRole("link", { name: "Docks", exact: true })).toBeVisible()

    // Switch by the timeline's link: the URL names the thread; reads settle, not repeat.
    const before = sent.length
    await row.getByRole("link", { name: "Docks", exact: true }).click()
    await expect(trigger(page, "Thread", "Docks")).toBeVisible()
    const docks = new URL(page.url()).searchParams.get("fork") as ForkId
    expect(docks).toBeTruthy()
    await expect(timelineRow(page)).toContainText("Docks (this one)")
    await page.waitForTimeout(1500)
    const settled = sent.length
    const switched = sent.slice(before)
    const count = (tag: string) => switched.filter((t) => t === tag).length
    expect(count("ThreadsOf")).toBeLessThanOrEqual(3)
    expect(count("ListForks")).toBeLessThanOrEqual(3)
    expect(count("ReadPath")).toBeLessThanOrEqual(4)
    await page.waitForTimeout(1500)
    expect(sent.length - settled, `requests after switching: ${sent.slice(settled).join(", ")}`).toBeLessThanOrEqual(1)

    // From the docks, the first thread is a thread too, not a branch; the side path still is one.
    await trigger(page, "Thread", "Docks").click()
    await expect(menu.locator("[data-threads-section]")).toContainText("Mira and Tobin")
    await expect(menu.getByRole("list", { name: "Branches" })).not.toContainText("Mira and Tobin")
    await expect(menu.getByRole("list", { name: "Branches" })).toContainText("Side path")
    await page.keyboard.press("Escape")

    // A middle-click on the first thread's link opens it in a new browser tab.
    const link = timelineRow(page).getByRole("link", { name: "Mira and Tobin", exact: true })
    const [opened] = await Promise.all([context.waitForEvent("page"), link.click({ button: "middle" })])
    await opened.waitForLoadState()
    expect(new URL(opened.url()).pathname).toBe(`/chats/${chat.chatId}`)
    await expect(trigger(opened, "Thread", "Mira and Tobin")).toBeVisible()
    await opened.close()

    // The left panel lists them as threads, before the branches.
    if (phone) await page.getByRole("button", { name: "Chats and menu" }).click()
    const foot = page.getByRole("region", { name: "Branches of the open chat" })
    // Collapsed where the panel has no room for it: its heading opens it.
    const heading = foot.getByRole("button", { name: /^Threads and branches of / })
    if ((await heading.getAttribute("aria-expanded")) === "false") await heading.click()
    await expect(foot).toContainText("Threads")
    await expect(foot.getByRole("link", { name: "Open thread Docks", exact: true })).toBeVisible()
    await expect(foot.getByRole("link", { name: "Open thread Mira and Tobin", exact: true })).toBeVisible()
    await expect(foot.getByRole("button", { name: /^Open branch Side path/ })).toBeVisible()
    const docksLink = foot.getByRole("link", { name: "Open thread Docks", exact: true })
    const [linked] = await Promise.all([context.waitForEvent("page"), docksLink.click({ button: "middle" })])
    await expect(trigger(linked, "Thread", "Docks")).toBeVisible()
    await linked.close()
    await docksLink.click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: "Open in a new browser tab", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expectLayout(page, info, `threads-left-panel-${suffix}`, {
      scope: '[aria-label="Branches of the open chat"]'
    })
    if (phone) await page.getByRole("button", { name: "Close", exact: true }).first().click()

    const storedSplit = (await admin((api) => api.ThreadsOf({ chatId: chat.chatId, forkId: chat.forkId })))[0]!.splitId
    // A second tab on the docks.
    const second = await context.newPage()
    const secondSent = recordRequests(second)
    await second.setViewportSize({ width, height: phone ? 844 : 1000 })
    await second.goto(`${server().url}/chats/${chat.chatId}?fork=${docks}`)
    await expect(trigger(second, "Thread", "Docks")).toBeVisible()

    await expectSettled(second, secondSent, "initial second tab")
    const undoBefore = sent.length
    const secondUndo = secondSent.length
    // Undo, from the timeline's row: the docks go to the bin; this tab shows the branch they started in.
    await timelineRow(page).getByRole("button", { name: "Undo starting the threads from #6" }).click()
    await expect(trigger(page, "Branch", "Original")).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get("fork") ?? chat.forkId).toBe(chat.forkId)

    await expect(timelineRow(page)).toHaveCount(0)
    await expect(second.getByText("This branch is no longer available. Showing the current branch.")).toBeVisible()
    await expect(timelineRow(second)).toHaveCount(0)

    await expectSettled(page, sent, "Undo", undoBefore)
    await expectSettled(second, secondSent, "Undo in sibling", secondUndo)

    // Restored from the toast: they're threads again, in both tabs.
    const binned = page.locator("[data-toast]").filter({ hasText: "moved to the bin." })
    await binned.getByRole("button", { name: "Undo", exact: true }).click()
    await expect(timelineRow(page)).toContainText("Docks")
    await expect(trigger(page, "Thread", "Mira and Tobin")).toBeVisible()
    await expect(timelineRow(second)).toContainText("Docks")
    await second.reload()
    await expect(trigger(second, "Thread", "Mira and Tobin")).toBeVisible()
    const undone = await admin((api) => api.UndoThreads({ chatId: chat.chatId, splitId: storedSplit }))
    await admin((api) => api.PurgeBinItem({ itemId: undone.id }))
    await second.goto(`${server().url}/chats/${chat.chatId}?fork=${docks}`)
    await expect(second.getByText("This branch is no longer available. Showing the current branch.")).toBeVisible()
    await expect(trigger(second, "Branch", "Original")).toBeVisible()
    await expect.poll(() => new URL(second.url()).searchParams.get("fork")).toBe(chat.forkId)
    await second.close()
  })

for (const [width, theme] of [
  [1440, "light"],
  [1440, "dark"],
  [390, "light"],
  [390, "dark"]
] as const)
  test(`threads at an earlier message: what the dialog says, the played messages, a note copied (${width} ${theme})`, async ({
    page
  }, info) => {
    test.setTimeout(120_000)
    const suffix = `earlier-${width}-${theme}`
    const chat = await seed(suffix)
    await open(page, `/chats/${chat.chatId}`, width, theme)
    const third = page.getByRole("article").filter({ hasText: "Tobin waves the cart on." })
    await messageMenu(third, "Start parallel threads here…")
    const dialog = await moveWren(page, 3, "At the gate")
    await expect(dialog.locator("[data-thread-played]")).toHaveText(
      "#4–#6 become this branch’s thread. Wren counts as not there for them, in this branch only. They still know their own messages."
    )
    await expectLayout(page, info, `threads-dialog-earlier-${width}-${theme}`, { scope: '[role="dialog"]' })
    await dialog.getByRole("button", { name: "Start", exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // The played messages stay here, the row after #3, before them.
    await expect(page.getByRole("article").filter({ hasText: "Mira points at the harbor." })).toBeVisible()
    const row = timelineRow(page)
    await expect(row).toContainText("At the gate")
    const order = await page.evaluate(() => {
      const row = document.querySelector("[data-threads-row]")!
      const articles = [...document.querySelectorAll("article")]
      const at = (text: string) => articles.find((a) => a.textContent?.includes(text))!
      const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      return [follows(at("Tobin waves the cart on."), row), follows(row, at("Wren listens at the gate."))]
    })
    expect(order).toEqual([true, true])
    const stored = await admin((api) => api.ThreadsOf({ chatId: chat.chatId, forkId: chat.forkId }))
    expect(stored[0]!.position).toBe(2)
    expect(stored[0]!.threads.map((t) => [t.name, t.cast])).toEqual([
      [null, stored[0]!.threads[0]!.cast],
      ["At the gate", [chat.wren]]
    ])
    const gate = stored[0]!.threads[1]!.forkId

    // A note made before the threads: both have it. Changed in this one, offered to the other.
    await admin((api) =>
      api.CreateChatNote({
        chatId: chat.chatId,
        forkId: chat.forkId,
        title: "Harbor watch",
        content: "Fog over the harbor."
      })
    )
    const notes = await openPanel(page, "Notes")
    const also = notes.getByRole("button", { name: "Also change it in “At the gate”", exact: true })
    await also.click()
    await expect(
      page.locator("[data-toast]").filter({ hasText: "“At the gate” has this note as it is already" })
    ).toBeVisible()
    const editor = notes.getByRole("region", { name: "Note Harbor watch" })
    await editor.getByRole("textbox", { name: "Text of Harbor watch" }).fill("Fog over the harbor, and bells.")
    await saveRevision(editor)
    await also.click()
    await expect(page.locator("[data-toast]").filter({ hasText: "Changed in “At the gate” too" })).toBeVisible()
    await expectLayout(page, info, `threads-note-${width}-${theme}`, { scope: "[data-note-also]" })
    const there = await admin((api) => api.ListChatNotes({ chatId: chat.chatId, forkId: gate, slotId: chat.slots[2]! }))
    expect(there.map((note) => note.doc["content"])).toContain("Fog over the harbor, and bells.")
  })

for (const [width, theme] of [
  [1440, "light"],
  [1440, "dark"],
  [390, "light"],
  [390, "dark"]
] as const)
  test(`ten thread sets stay inside the branch menu (${width} ${theme})`, async ({ page }, info) => {
    test.setTimeout(120_000)
    const chat = await seed(`many-${width}-${theme}`)
    await admin((api) =>
      Effect.gen(function* () {
        for (let i = 0; i < 10; i++) {
          const entry = (yield* api.ReadPath({
            chatId: chat.chatId,
            forkId: chat.forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 1
          })).entries[0]!
          const cast = yield* api.GetCast({ chatId: chat.chatId, forkId: chat.forkId, slotId: entry.slotId })
          yield* api.StartThreads({
            chatId: chat.chatId,
            forkId: chat.forkId,
            slotId: entry.slotId,
            expectedRowVersion: entry.rowVersion,
            threads: [
              { name: `Market ${i}`, cast: cast.participants, writesAs: null },
              { name: `Harbor ${i}`, cast: [chat.wren], writesAs: null }
            ]
          })
        }
      })
    )
    await open(page, `/chats/${chat.chatId}?fork=${chat.forkId}`, width, theme)
    await trigger(page, "Thread", "Market 9").click()
    const menu = branchMenu(page)
    await expect(menu.locator("[data-thread-set]")).toHaveCount(10)
    await expectLayout(page, info, `threads-many-${width}-${theme}`, { scope: '[role="dialog"]' })
    const bounds = await menu.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
    const last = menu.locator("[data-thread-set]").last().getByRole("link").last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    await expect(menu.getByRole("list", { name: "Branches" })).toBeInViewport()
  })

test("thread identity names the browser tab", async ({ page }) => {
  const chat = await seed("tab-name")
  await open(page, `/chats/${chat.chatId}`, 1440, "light")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Start parallel threads…", exact: true }).click()
  const dialog = await moveWren(page, 6, "At the docks")
  await dialog.getByRole("button", { name: "Start", exact: true }).click()
  await timelineRow(page).getByRole("link", { name: "At the docks", exact: true }).click()
  await expect(trigger(page, "Thread", "At the docks")).toBeVisible()
  await expect(page).toHaveTitle(/Thread: At the docks/)
})

test("thread links have the app's chrome menu", async ({ page }) => {
  const chat = await seed("chrome-menu")
  await open(page, `/chats/${chat.chatId}`, 1440, "light")
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Start parallel threads…", exact: true }).click()
  const dialog = await moveWren(page, 6, "At the docks")
  await dialog.getByRole("button", { name: "Start", exact: true }).click()
  await trigger(page, "Thread", "Mira and Tobin").click()
  await branchMenu(page)
    .getByRole("link", { name: /^Thread At the docks:/ })
    .click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Open in a new browser tab", exact: true })).toBeVisible()
})

test("nested Start and Undo settle while another tab stays in a sibling thread", async ({ page, context }) => {
  test.setTimeout(120_000)
  const chat = await seed("nested-lifecycle")
  const outer = await admin((api) =>
    Effect.gen(function* () {
      const entry = (yield* api.ReadPath({
        chatId: chat.chatId,
        forkId: chat.forkId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 1
      })).entries[0]!
      const cast = yield* api.GetCast({ chatId: chat.chatId, forkId: chat.forkId, slotId: entry.slotId })
      return yield* api.StartThreads({
        chatId: chat.chatId,
        forkId: chat.forkId,
        slotId: entry.slotId,
        expectedRowVersion: entry.rowVersion,
        threads: [
          { name: "Market", cast: cast.participants.filter((id) => id !== chat.wren), writesAs: null },
          { name: "Outer docks", cast: [chat.wren], writesAs: null }
        ]
      })
    })
  )
  const sent = recordRequests(page)
  await open(page, `/chats/${chat.chatId}?fork=${chat.forkId}`, 1440, "light")
  const second = await context.newPage()
  const siblingSent = recordRequests(second)
  await open(second, `/chats/${chat.chatId}?fork=${outer.forkIds[1]!}`, 1440, "light")
  await expect(trigger(second, "Thread", "Outer docks")).toBeVisible()
  await expectSettled(page, sent, "initial nested source")
  await expectSettled(second, siblingSent, "initial sibling thread")
  const before = sent.length
  const siblingBefore = siblingSent.length
  await page.getByRole("button", { name: "Chat actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Start parallel threads…", exact: true }).click()
  const dialog = await moveWren(page, 6, "Inner docks")
  await dialog.getByRole("button", { name: "Start", exact: true }).click()
  await expectSettled(page, sent, "nested Start", before)
  await expectSettled(second, siblingSent, "sibling after nested Start", siblingBefore)
  await expect(trigger(second, "Thread", "Outer docks")).toBeVisible()
  const nested = (await admin((api) => api.ThreadsOf({ chatId: chat.chatId, forkId: chat.forkId }))).find(
    (set) => set.splitId !== outer.splitId
  )!
  const undoBefore = sent.length
  const siblingUndo = siblingSent.length
  await page
    .locator(`[data-threads-row="${nested.splitId}"]`)
    .getByRole("button", { name: "Undo starting the threads from #6" })
    .click()
  await expectSettled(page, sent, "nested Undo", undoBefore)
  await expectSettled(second, siblingSent, "sibling after nested Undo", siblingUndo)
  await expect(trigger(second, "Thread", "Outer docks")).toBeVisible()
  expect(new URL(second.url()).searchParams.get("fork")).toBe(outer.forkIds[1])
  await second.close()
})
