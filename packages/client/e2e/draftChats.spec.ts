// New chats are pending chats (DESIGN §2.1, owner 2026-11-23): the new-chat page opens a real
// chat the server keeps out of every list until its first turn, shown by the chat page itself.
import { expectLayout } from "./support/layoutAudit.ts"
import { expect, test, type Page } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { showActions } from "./support/message.ts"
import { closePanel, openPanel } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "10000", FAKE_GENERATOR_TOKENS: "10" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

const importCard = async (page: Page, data: Record<string, unknown>) => {
  const response = await page.request.post(`${server().url}/library/import?name=fixture.json`, {
    data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  const cards = await admin((api) => api.ListCards())
  return cards.find((card) => card.name === data.name)!
}

/** Everything account-wide a draft must not change: lists, counts, last used times. */
const accountState = () =>
  admin((api) =>
    Effect.map(
      Effect.all({
        cards: api.GetShellCards(),
        usage: api.ListCardUsage(),
        library: api.GetShellLibrary(),
        chats: api.ListChats({ limit: 500, before: null })
      }),
      (state) => JSON.stringify(state)
    )
  )

const draftOf = (page: Page) => new URL(page.url()).searchParams.get("draft")

const listed = async (chatId: string) =>
  (await admin((api) => api.ListChats({ limit: 500, before: null }))).some((chat) => chat.id === chatId)

const composer = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true })

const chatUrl = (chatId: string) => new RegExp(`/chats/${chatId}(\\?|$)`)

/** Opens a new chat at `path` and answers its pending chat's id, once its page shows it. */
const openDraft = async (page: Page, path: string) => {
  await page.goto(`${server().url}${path}`)
  await expect.poll(() => draftOf(page)).not.toBeNull()
  await expect(composer(page)).toBeEditable()
  return draftOf(page)!
}

const start = async (page: Page) => {
  await page.setViewportSize({ width: 1340, height: 900 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

test.describe.configure({ mode: "parallel" })

const NOT_STARTED = "Available once the chat is started: send a message first."

test("a card's new chat changes nothing until it starts, and a reload keeps it", async ({ page }) => {
  await start(page)
  const card = await importCard(page, {
    name: "Mira Reload",
    first_mes: "Mira opens the door.",
    alternate_greetings: ["Mira waves.", "Mira smiles."]
  })
  const before = await accountState()
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  const greeting = page.getByRole("article").filter({ hasText: /Mira (opens the door|waves|smiles)\./ })
  await expect(greeting).toContainText("Mira Reload")
  const shown = await greeting.locator(".markdown").innerText()
  // Not in the sidebar, nor in any list or count; the card's last use is as it was.
  await expect(page.locator(`[data-chat-id="${draft}"]`)).toHaveCount(0)
  expect(await accountState()).toBe(before)
  await page.reload()
  await expect(greeting).toContainText("Mira Reload")
  expect(draftOf(page)).toBe(draft)
  expect(await greeting.locator(".markdown").innerText()).toBe(shown)
  expect(await accountState()).toBe(before)
})

test("saving an edit of the greeting starts the chat", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Edit", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  const greeting = page.getByRole("article").filter({ hasText: "Mira opens the door." })
  await showActions(greeting)
  await greeting.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = greeting.getByRole("textbox", { name: "Message text", exact: true })
  await editor.fill("Mira opens the door wide.")
  await greeting.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page).toHaveURL(chatUrl(draft))
  await expect(page.getByRole("article").filter({ hasText: "Mira opens the door wide." })).toBeVisible()
  expect(await listed(draft)).toBe(true)
  await expect(page.locator(`[data-chat-id="${draft}"]`).first()).toBeVisible()
})

test("a new chat left unsent is swept, its typing in recovered texts, nothing in the bin", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Leave", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  await composer(page).fill("Words typed and never sent.")
  // The composer's draft is saved on the server before the page is left.
  await expect
    .poll(() =>
      admin((api) => Effect.map(api.OpenComposer({ chatId: draft as ChatId, forkId: null }), (d) => d.content))
    )
    .toBe("Words typed and never sent.")
  // Typing kept its tab, which Home opens beside: closing the tab leaves the chat.
  await page.getByRole("link", { name: "Home", exact: true }).first().click()
  await page.getByRole("button", { name: /^Close Mira Leave/ }).click()
  await expect(page).not.toHaveURL(/draft=/)
  await expect
    .poll(
      async () =>
        (await admin((api) => api.ListRecoveredTexts({ limit: 50, before: null }))).map((text) => text.sourceLabel),
      { timeout: 20_000 }
    )
    .toContain("New chat with Mira Leave")
  expect(await listed(draft)).toBe(false)
  expect(await admin((api) => api.ListBin({ limit: 50, before: null }))).toEqual([])
})

test("sending a message starts the chat with the greeting and the message", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Send", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  await composer(page).fill("Hello, Mira.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(chatUrl(draft))
  await expect(page.getByRole("article").filter({ hasText: "Hello, Mira." })).toBeVisible()
  await expect(page.getByRole("article").filter({ hasText: "Mira opens the door." })).toBeVisible()
  expect(await listed(draft)).toBe(true)
})

test("duplicating the greeting starts the chat, and the page follows", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Twice", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  const greeting = page.getByRole("article").filter({ hasText: "Mira opens the door." })
  await showActions(greeting.first())
  await greeting.first().getByRole("button", { name: "More actions" }).click()
  await page.getByRole("menuitem", { name: /^Duplicate/ }).click()
  await expect(page).toHaveURL(chatUrl(draft))
  await expect(greeting).toHaveCount(2)
  expect(await listed(draft)).toBe(true)
})

test("a History replacement in its greeting starts the chat, and the page follows", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Replace", first_mes: "Mira waves at the ferry." })
  const draft = (await openDraft(page, `/cards/${card.entityId}/chat`)) as ChatId
  await expect(page.getByRole("article").filter({ hasText: "Mira waves at the ferry." })).toBeVisible()
  // The same write the History panel's replace makes, from another tab or this one.
  await admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.GetChat({ chatId: draft })
      const path = yield* api.ReadPath({
        chatId: draft,
        forkId: null,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 10
      })
      const version = path.entries[0]!.version
      yield* api.ApplyHistoryEdits({
        title: "Replace",
        applications: [
          {
            chatId: draft,
            forkId: chat.currentForkId!,
            edits: [
              {
                kind: "version_replace" as const,
                targetId: version.id,
                beforeId: version.id,
                before: version.content,
                after: version.content.replace("waves", "nods")
              }
            ]
          }
        ]
      })
    })
  )
  await expect(page).toHaveURL(chatUrl(draft))
  await expect(page.getByRole("article").filter({ hasText: "Mira nods at the ferry." })).toBeVisible()
  expect(await listed(draft)).toBe(true)
})

test("a new chat the server swept while it was open gives way to a fresh one, quietly", async ({ page }) => {
  await start(page)
  // The server ends a swept chat's subscriptions with Deleted (a tab back from a long sleep, say).
  // Sent here into the page's own subscription, a batch of one event, as the server sends it.
  const subscriptions = new Map<string, unknown>()
  let deleted: ((chatId: string) => void) | null = null
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      upstream.send(data)
      if (typeof data !== "string") return
      const parsed = JSON.parse(data) as unknown
      for (const message of (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>)
        if (message["_tag"] === "Request" && message["tag"] === "SubscribeChat")
          subscriptions.set((message["payload"] as { chatId: string }).chatId, message["id"])
    })
    upstream.onMessage((data) => socket.send(data))
    deleted = (chatId) =>
      socket.send(
        JSON.stringify({ _tag: "Chunk", requestId: subscriptions.get(chatId), values: [[{ _tag: "Deleted" }]] })
      )
  })
  const card = await importCard(page, { name: "Mira Swept", first_mes: "Mira opens the door." })
  const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
  await composer(page).fill("Typed before the sleep.")
  await expect
    .poll(() =>
      admin((api) => Effect.map(api.OpenComposer({ chatId: draft as ChatId, forkId: null }), (d) => d.content))
    )
    .toBe("Typed before the sleep.")
  await expect.poll(() => subscriptions.has(draft)).toBe(true)
  deleted!(draft)
  // Another new chat for the same card, in place: its URL names it, its greeting shows, and
  // nothing says anything happened.
  await expect.poll(() => draftOf(page)).not.toBe(draft)
  const fresh = draftOf(page)!
  await expect(page).toHaveURL(new RegExp(`/cards/${card.entityId}/chat\\?draft=${fresh}`))
  await expect(page.getByRole("article").filter({ hasText: "Mira opens the door." })).toBeVisible()
  await expect(composer(page)).toBeEditable()
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect((await admin((api) => api.GetChat({ chatId: fresh as ChatId }))).status).toBe("pending")
  // What was typed in the one swept is in recovered texts, and neither is listed.
  await expect
    .poll(
      async () =>
        (await admin((api) => api.ListRecoveredTexts({ limit: 50, before: null }))).map((text) => text.sourceLabel),
      { timeout: 20_000 }
    )
    .toContain("New chat with Mira Swept")
  expect(await listed(draft)).toBe(false)
  expect(await listed(fresh)).toBe(false)
})

test("a new chat's own notes and snippets wait, disabled, saying why", async ({ page }) => {
  await start(page)
  const card = await importCard(page, { name: "Mira Notes", first_mes: "Mira opens the door." })
  await openDraft(page, `/cards/${card.entityId}/chat`)
  const notes = await openPanel(page, "Notes")
  const own = notes.getByRole("region", { name: "This chat's notes" })
  for (const name of ["Add note", "Link shared note"]) {
    const button = own.getByRole("button", { name, exact: true })
    await expect(button).toHaveAttribute("aria-disabled", "true")
    await button.hover()
    await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(NOT_STARTED)
  }
  const snippets = await openPanel(page, "Snippets")
  const create = snippets.getByRole("button", { name: "New snippet", exact: true })
  await expect(create).toHaveAttribute("aria-disabled", "true")
  await create.hover()
  await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(NOT_STARTED)
  // Once started, they're there to use.
  await closePanel(page)
  await composer(page).fill("Hello, Mira.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/\/chats\//)
  const started = await openPanel(page, "Notes")
  await expect(
    started.getByRole("region", { name: "This chat's notes" }).getByRole("button", { name: "Add note", exact: true })
  ).not.toHaveAttribute("aria-disabled", "true")
})

const SHOTS = process.env.DRAFT_SHOTS

/** Where the header's controls are, by name: nothing may move as the chat starts. */
const headerBoxes = (page: Page) =>
  page
    .locator("[data-chat-main]")
    .first()
    .evaluate((main) => {
      const header = main.querySelector("header") ?? main.firstElementChild!
      const boxes: Record<string, [number, number, number]> = {}
      for (const control of header.querySelectorAll("button, a")) {
        const name = control.getAttribute("aria-label") ?? control.textContent ?? ""
        // The branch control names the branch, whose label may change; its box may not.
        const key = name.startsWith("Branch:") ? "branch" : name
        const r = control.getBoundingClientRect()
        // Where each starts: the title may take the room its "new" badge leaves.
        if (r.width > 0) boxes[key] = [Math.round(r.x), Math.round(r.y), Math.round(r.height)]
      }
      return boxes
    })

for (const width of [1340, 390])
  test(`a new chat's refused controls stay in place, disabled, saying why, at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await page.addInitScript(() => localStorage.setItem("dreamspan.theme", "dark"))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const card = await importCard(page, { name: `Mira Controls ${width}`, first_mes: "Mira opens the door." })
    const draft = await openDraft(page, `/cards/${card.entityId}/chat`)
    const greeting = page.getByRole("article").filter({ hasText: "Mira opens the door." })
    await expect(greeting).toContainText(`Mira Controls ${width}`)
    await expect(page.getByRole("button", { name: /^Branch: / })).toBeVisible()
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/draft-${width}-dark.png` })
    await expectLayout(page, info, `draft-${width}-dark`)
    const before = await headerBoxes(page)
    if (width > 640) {
      const pin = page.getByRole("button", { name: "Pin this branch", exact: true })
      await expect(pin).toHaveAttribute("aria-disabled", "true")
      await pin.hover()
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(NOT_STARTED)
    }
    // The ⋯ menu lists what a started chat has, disabled, each saying why.
    await page.getByRole("button", { name: "Chat actions", exact: true }).click()
    for (const name of ["Branches…", "Export…"]) {
      const item = page.getByRole("menuitem", { name, exact: true })
      await expect(item).toHaveAttribute("aria-disabled", "true")
      await item.hover()
      // Beside the list on a wide screen; under the label on a phone.
      await expect(
        width > 640 ? page.locator("[data-explanation]") : item.getByText(NOT_STARTED, { exact: true })
      ).toHaveText(NOT_STARTED)
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/draft-menu-${width}-dark.png` })
    await expectLayout(page, info, `draft-menu-${width}-dark`)
    await page.keyboard.press("Escape")
    // A message's own: Branch from here and Delete, the same.
    await showActions(greeting)
    await greeting.getByRole("button", { name: "More actions" }).click()
    for (const name of [/^Branch from here/, /^Delete message/]) {
      const item = page.getByRole("menuitem", { name })
      await expect(item).toHaveAttribute("aria-disabled", "true")
      // Its reason is a note under the label, in this menu.
      await expect(item.getByText(NOT_STARTED, { exact: true })).toBeVisible()
    }
    await page.keyboard.press("Escape")
    await composer(page).fill("Hello, Mira.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(chatUrl(draft))
    await expect(page.getByRole("article").filter({ hasText: "Hello, Mira." })).toBeVisible()
    await page.mouse.move(0, 0)
    if (width > 640) await expect(page.getByRole("button", { name: "Pin this branch", exact: true })).toHaveCount(0)
    const after = await headerBoxes(page)
    for (const [name, box] of Object.entries(before))
      if (name !== "new" && after[name] !== undefined) expect([name, after[name]]).toEqual([name, box])
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/started-${width}-dark.png` })
    void info
  })

for (const kind of ["group", "empty"] as const)
  test(`a new ${kind} chat is a draft the same way`, async ({ page }) => {
    await start(page)
    let entry = "/new/chat"
    if (kind === "group") {
      const first = await importCard(page, { name: "Group Ana", first_mes: "Ana says hi." })
      const second = await importCard(page, { name: "Group Ben", first_mes: "Ben nods." })
      const group = await admin((api) =>
        api.StartChat({
          cards: [first.entityId, second.entityId],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "An earlier group chat.", speakerEntityId: null }
        })
      )
      entry = `/groups/${group.chat.id}/new`
    }
    const before = await accountState()
    let draft: string
    if (kind === "group") {
      draft = await openDraft(page, entry)
      await expect(page.getByRole("article").filter({ hasText: "Ana says hi." })).toBeVisible()
      await expect(page.getByRole("article").filter({ hasText: "Ben nods." })).toBeVisible()
    } else {
      // The Chats page's start card: its title names the chat it opens.
      await page.goto(`${server().url}/chats`)
      await page.getByRole("textbox", { name: "Title of the new chat", exact: true }).fill("Notes on tea")
      await page.getByRole("button", { name: "New chat", exact: true }).click()
      await expect.poll(() => draftOf(page)).not.toBeNull()
      draft = draftOf(page)!
      await expect(page.locator("[data-empty-chat-intro]")).toBeVisible()
      await expect(page.locator("[data-chat-main]").getByText("Notes on tea", { exact: true }).first()).toBeVisible()
    }
    expect(await accountState()).toBe(before)
    await composer(page).fill("The first words.")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect(page).toHaveURL(chatUrl(draft))
    await expect(page.getByRole("article").filter({ hasText: "The first words." })).toBeVisible()
    expect(await listed(draft)).toBe(true)
  })
