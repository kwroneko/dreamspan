// The chat screens against a server with the fake generator: sending, streaming replies,
// versions, stopping, editing, links to a message, branches, deleting; another user never
// sees the chat; and every chat screen at phone and desktop width, light and dark.
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import type { Chat, SlotId } from "@dreamspan/shared/chat.ts"
import type { SendResult } from "@dreamspan/shared/chatApi.ts"
import { Effect } from "effect"
import { messageMenu, showActions } from "./support/message.ts"
import { expectFlashedThenUnmarked, recordFlashes } from "./support/flashes.ts"
import { REPLY, startProvider } from "./support/provider.ts"
import { asPage, asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, startServer, withAdmin } from "./support/server.ts"

// About two seconds a reply: long enough to stop one, short enough to wait for.
const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "80", FAKE_GENERATOR_TOKENS: "160" })

/** A message's text without its layout's whitespace. */
const textOf = async (message: Locator) =>
  ((await message.locator(".markdown").textContent()) ?? "").replace(/\s+/g, "")

const replies = (page: Page) => page.getByRole("article", { name: "Reply" })
const generating = (page: Page) => page.getByText("generating", { exact: true })

/** Waits for the chat to show `count` replies, none still generating. */
const repliesDone = async (page: Page, count: number) => {
  await expect(replies(page)).toHaveCount(count)
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // The list followed the reply as it grew: it ends on screen.
  const list = await page.getByTestId("messages").boundingBox()
  const reply = await replies(page).last().boundingBox()
  expect(reply!.y + reply!.height).toBeLessThanOrEqual(list!.y + list!.height + 1)
}

/** A saved chat with nobody in it, open (the Chats page's New chat makes nothing until the first send). */
const newChat = async (page: Page, title: string, host = server()) => {
  await apiLogin(page.request, host, ADMIN.handle, ADMIN.password)
  const chat = await asPage(page, host, (api) => api.CreateChat({ title }))
  await page.goto(`${host.url}/chats/${chat.id}`)
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
}

const send = async (page: Page, text: string) => {
  await page.getByLabel("Message", { exact: true }).fill(text)
  await page.getByRole("button", { name: "Send" }).click()
}

test("a message gets a streamed reply, with versions to swipe through", async ({ page }) => {
  await newChat(page, "Harbor")
  await send(page, "The lantern swings over the *harbor*.")
  await expect(page.getByRole("article", { name: "Your message" }).locator("em")).toHaveText("harbor")
  await expect(generating(page)).toBeVisible()
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  const reply = replies(page).last()
  const first = await textOf(reply)
  expect(first.length).toBeGreaterThan(100)

  // Past the last version, a swipe generates another; swiping back shows the first again.
  await reply.getByRole("button", { name: "Generate another version" }).click()
  await expect(reply.getByRole("group", { name: "Versions" })).toContainText("2/2")
  await expect(reply.getByText("generating", { exact: true })).toBeVisible()
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  const second = await textOf(reply)
  expect(second).not.toEqual(first)
  await reply.getByRole("button", { name: "Previous version" }).click()
  await expect(reply.getByRole("group", { name: "Versions" })).toContainText("1/2")
  await expect.poll(() => textOf(reply)).toBe(first)

  // The reload shows the same, from the server.
  await page.reload()
  await expect.poll(() => textOf(replies(page).last())).toBe(first)
})

test("a stopped reply keeps its text, and a message can be edited, linked to, branched from and deleted", async ({
  page
}) => {
  test.setTimeout(120_000)
  const heldServer = await startServer(withAdmin)
  const heldProvider = await startProvider({ holdAfterText: true })
  try {
    await asUser(heldServer, ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Held Stop fixture",
            baseUrl: heldProvider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          apiKey: "synthetic"
        })
        yield* api.RefreshModels({ connectionId: connection.id })
        const models = yield* api.ListModels({ connectionId: connection.id, includeHidden: false })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: models[0]!.id }, preset: null }
        })
      })
    )
    await newChat(page, "Chapel", heldServer)
    await send(page, "Knock twice.")
    await expect(generating(page)).toBeVisible()
    const reply = replies(page).last()
    await expect(reply.locator(".markdown")).toHaveText(REPLY)
    // Stop belongs to this version (DESIGN §3.1). Its stream stays open until
    // stopped, so the assertion cannot race a two-second synthetic completion.
    await reply.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(reply.getByText("stopped", { exact: true })).toBeVisible()
    expect((await reply.locator(".markdown").innerText()).length).toBeGreaterThan(0)
    heldProvider.release()

    // A message the user wrote is changed in place.
    const mine = page.getByRole("article", { name: "Your message" }).first()
    await showActions(mine)
    await mine.getByRole("button", { name: "Edit" }).click()
    await mine.getByLabel("Message text").fill("Knock three times.")
    await mine.getByRole("button", { name: "Save" }).click()
    await expect(mine.locator(".markdown")).toHaveText("Knock three times.")
    // Amended in place: still its only version.
    await expect(mine.getByRole("group", { name: "Versions" })).toContainText("1/1")

    // A copied link opens the chat at that message.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await messageMenu(mine, "Copy link")
    await expect(page.getByText("Link copied")).toBeVisible()
    const link = await page.evaluate(() => navigator.clipboard.readText())
    expect(link).toMatch(/slot=/)
    await recordFlashes(page)
    await page.goto(link)
    // It flashes, then is left unmarked.
    await expectFlashedThenUnmarked(
      page,
      page.locator(`article[data-slot="${new URL(link).searchParams.get("slot")}"]`)
    )

    // A branch from the first message: the reply below it isn't on it.
    await messageMenu(page.getByRole("article", { name: "Your message" }).first(), "Branch from here")
    // A fork made by branching is the current one: the chat's own URL opens on it.
    await expect(page).toHaveURL(/fork=/)
    await expect(replies(page)).toHaveCount(0)
    await send(page, "Walk away instead.")
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2)
    await repliesDone(page, 1)
    // The branch is now the chat's latest: the chat's own URL opens on it.
    await page.goto(page.url().split("?")[0]!)
    await expect(page.getByTestId("messages").getByText("Walk away instead.")).toBeVisible()
    await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2)

    // Deleting goes to the bin; the message is gone from the path.
    const walk = page.getByRole("article", { name: "Your message" }).filter({ hasText: "Walk away" })
    await showActions(walk)
    await walk.getByRole("button", { name: "Delete message", exact: true }).click()
    // The delete toast quotes it for its 10 s; the chat itself no longer shows it.
    await expect(page.getByTestId("messages").getByText("Walk away instead.")).toHaveCount(0)
  } finally {
    await heldProvider.stop()
    await heldServer.stop()
  }
})

test("a message sent from an older part of the chat lands at the end, with its reply", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const { chat, first } = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Long enough" })
      let parent: SlotId | null = null
      let first: SlotId | null = null
      for (let i = 0; i < 90; i++) {
        const sent: SendResult = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content: `Message ${i}`
        })
        if (sent._tag !== "Posted") throw new Error("nothing is generating, so nothing queues")
        parent = sent.entry.slotId
        first ??= parent
      }
      return { chat, first: first! }
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}?slot=${first}`)
  await expect(page.getByTestId("messages").getByText("Message 0", { exact: true })).toBeVisible()
  await send(page, "From the start")
  await expect(page.getByTestId("messages").getByText("From the start")).toBeVisible()
  await repliesDone(page, 1)
  const path = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 3 })
  )
  expect(path.entries.map((e) => e.version.writer)).toEqual(["human", "human", "model"])
  expect(path.entries[1]!.version.content).toBe("From the start")
})

test("a branch's URL follows the messages sent on it", async ({ page }) => {
  await newChat(page, "Fork")
  await send(page, "First")
  await repliesDone(page, 1)
  await messageMenu(page.getByRole("article", { name: "Your message" }), "Branch from here")
  await expect(replies(page)).toHaveCount(0)
  const chatId = new URL(page.url()).pathname.split("/").at(-1)! as Chat["id"]
  const branch = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.GetChat({ chatId }).pipe(Effect.map((chat) => chat.currentForkId))
  )
  expect(branch).not.toBeNull()
  // The old branch already had fork= in its URL, and the rows clear before navigation.
  // Wait for the new, server-recorded fork rather than capturing the outgoing URL.
  await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(branch)
  await send(page, "Second, on the branch")
  await repliesDone(page, 1)
  await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(branch)
  await page.reload()
  await expect(page.getByTestId("messages").getByText("Second, on the branch")).toBeVisible()
  await expect(page.getByRole("article", { name: "Your message" })).toHaveCount(2)
})

test("a chat deleted elsewhere while open goes back to the chats", async ({ page }) => {
  await newChat(page, "Ember")
  const chatId = page.url().split("/chats/")[1]!.split("?")[0]! as Chat["id"]
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.DeleteChat({ chatId }))
  await expect(page).toHaveURL(/\/chats$/)
  // By its title: a row's name also carries its last message, which may mention embers.
  await expect(page.getByRole("link", { name: /^Ember\b/ })).toHaveCount(0)
})

test("another user can't open someone's chat", async ({ browser }) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreateUser({ handle: "dana", displayName: "Dana", role: "user", password: "dana-password-1" })
  )
  const chat = await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateChat({ title: "Private" }))
  const dana = await browser.newPage()
  await apiLogin(dana.request, server(), "dana", "dana-password-1")
  await dana.goto(`${server().url}/chats`)
  await expect(dana.getByText(/^No chats yet\./)).toBeVisible()
  await dana.goto(`${server().url}/chats/${chat.id}`)
  // Attachment drafts can report their own load error too; check the chat's
  // access refusal itself, while retaining the private-title assertion below.
  await expect(dana.getByRole("alert").filter({ hasText: /^This chat doesn't exist any more\.$/ })).toBeVisible()
  await expect(dana.getByText("Private")).toHaveCount(0)
})

const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

for (const scheme of ["light", "dark"] as const) {
  for (const [width, height, device] of [
    [390, 844, "phone"],
    [1280, 800, "desktop"]
  ] as const) {
    test(`chat screens: ${device}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme })
      const page = await context.newPage()
      const shoot = async (name: string) => {
        await noSidewaysScroll(page)
        const dir = process.env.SCREENSHOT_DIR
        if (dir) await page.screenshot({ path: join(dir, `${name}-${device}-${scheme}.png`) })
      }
      await newChat(page, `Layout ${device} ${scheme}`)
      await send(page, "A list:\n\n- one\n- two\n\n> and a quote, with `code`.")
      await repliesDone(page, 1)
      await shoot("chat")
      await page.goto(`${server().url}/chats`)
      await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible()
      await shoot("chats")
      await context.close()
    })
  }
}

test("a branch reply stays at the end when its summary divider arrives during an end scroll", async ({ page }) => {
  // Let the new leaf's summary state arrive after the reply has started an end scroll.
  let held = false
  let holdStream = false
  const reads: Array<() => void> = []
  const updates: Array<() => void> = []
  await page.routeWebSocket(/\/rpc$/, (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      if (held && typeof data === "string" && JSON.parse(data).tag === "GetLcmState") {
        reads.push(() => upstream.send(data))
      } else upstream.send(data)
    })
    upstream.onMessage((data) => {
      if (
        holdStream &&
        typeof data === "string" &&
        (data.includes('"_tag":"Delta"') || data.includes('"_tag":"Version"'))
      ) {
        updates.push(() => socket.send(data))
      } else socket.send(data)
    })
  })
  await newChat(page, "Divider race")
  await send(page, "First")
  await repliesDone(page, 1)
  await messageMenu(page.getByRole("article", { name: "Your message" }), "Branch from here")
  await expect(replies(page)).toHaveCount(0)
  await expect(page.getByTestId("lcm-boundary")).toHaveCount(1)

  // A busy frame leaves the virtualizer's index-based scroll pending while RPCs render
  // the reply and then insert a divider above it. Resume frames only after that insertion.
  held = true
  holdStream = true
  const frames = await page.evaluateHandle(() => {
    const request = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    const pending = new Map<number, FrameRequestCallback>()
    let id = 0
    window.requestAnimationFrame = (callback) => {
      pending.set(--id, callback)
      return id
    }
    window.cancelAnimationFrame = (frame) => {
      if (frame < 0) pending.delete(frame)
      else cancel(frame)
    }
    const resume = (flush = false) => {
      window.requestAnimationFrame = request
      window.cancelAnimationFrame = cancel
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) {
        if (flush) callback(performance.now())
        else request(callback)
      }
    }
    let observer: MutationObserver | null = null
    return {
      onDivider: () => {
        observer = new MutationObserver(() => {
          if (document.querySelector('[data-testid="lcm-boundary"]') === null) return
          observer!.disconnect()
          // Run the pending frame just after layout commits the divider. Deliver its
          // scroll event before a later passive effect can mask the wrong target.
          resume(true)
          document.querySelector('[data-testid="messages"]')!.dispatchEvent(new Event("scroll"))
        })
        observer.observe(document.querySelector('[data-testid="messages"]')!, { childList: true, subtree: true })
      },
      resume: () => {
        observer?.disconnect()
        resume()
      }
    }
  })
  try {
    await send(page, "Walk away instead.\n\n".repeat(8).trim())
    await expect(replies(page)).toHaveCount(1)
    await expect(generating(page)).toHaveCount(1)
    await expect(page.getByTestId("lcm-boundary")).toHaveCount(0)
    await expect.poll(() => reads.length).toBeGreaterThan(0)
    await expect
      .poll(() =>
        page.getByTestId("messages").evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight)
      )
      .toBeLessThanOrEqual(1)
    // Deliver the end scroll's event before inserting the divider, with its frame still
    // pending. The virtualizer must preserve that end target across the row-index change.
    await page.getByTestId("messages").evaluate((list) => list.dispatchEvent(new Event("scroll")))
    await frames.evaluate((control) => control.onDivider())
    held = false
    for (const read of reads) read()
    await expect(page.getByTestId("lcm-boundary")).toHaveCount(1)
  } finally {
    await frames.evaluate((control) => control.resume())
    await frames.dispose()
  }

  // Keep token growth from masking a wrong scroll target by resizing the row back to
  // the bottom. With frames running again, the inserted divider must leave it on screen.
  try {
    await expect(async () => {
      await page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      )
      const list = await page.getByTestId("messages").boundingBox()
      const reply = await replies(page).last().boundingBox()
      expect(reply!.y + reply!.height).toBeLessThanOrEqual(list!.y + list!.height + 1)
    }).toPass({ timeout: 5_000 })
  } finally {
    holdStream = false
    for (const update of updates) update()
  }
  await expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
  // Even allowing layout to settle, the reply must land fully inside the visible list.
  await expect(async () => {
    const list = await page.getByTestId("messages").boundingBox()
    const reply = await replies(page).last().boundingBox()
    expect(reply!.y + reply!.height).toBeLessThanOrEqual(list!.y + list!.height + 1)
  }).toPass({ timeout: 5_000 })
})
