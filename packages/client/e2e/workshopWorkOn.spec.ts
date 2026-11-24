// "Work on in a workshop" in the browser (spec/WORKSHOP-CARDS.md §4.1 point 3, unit C5): a
// lorebook's editor offers the workshops open in this browser tab's frames and A new workshop.
// Picking the open one puts the lorebook back in its message and focuses its composer; A new
// workshop opens the workshop not made yet with the item in its first message, which carries it.
// A card's More menu has the same as a submenu. Synthetic items and a scripted provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR

test.describe("work on in a workshop", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  // One login per file and worker: the server throttles logins.
  let cookie: Promise<string> | null = null
  const admin = async <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    withCookie(server(), await (cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)), use)
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({ perTask: true, calls: [], answer: () => "Noted." })
    await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic workshop",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
      })
    )
  })
  test.afterAll(async () => {
    await provider.stop()
  })

  const setUp = async (page: Page, width: number, theme: "dark" | "light") => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  }
  const shooter = (page: Page, width: number, theme: string) => async (label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    await page.waitForTimeout(200)
    await page.screenshot({ path: resolve(shots, `workon-${label}-${width}-${theme}.png`) })
  }
  const tip = (page: Page) => page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')

  for (const [width, theme] of [
    [1340, "dark"],
    [1340, "light"],
    [1920, "dark"]
  ] as const)
    test(`a lorebook's editor puts it in the workshop open beside, at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(150_000)
      await setUp(page, width, theme)
      const shot = shooter(page, width, theme)
      const book = await admin((api) => api.CreateLorebook({ label: `Harbor lore ${theme}` }))
      const workshop = await admin((api) => api.CreateWorkshop({ title: `Work ${theme}` }))
      const draft = await admin((api) => api.OpenComposer({ chatId: workshop.id, forkId: null }))
      await admin((api) =>
        api.SetComposerLibrary({ chatId: workshop.id, draftId: draft.id, add: [book.id], remove: [] })
      )

      await page.goto(`${server().url}/chats/${workshop.id}`)
      const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
      await expect(tiles).toHaveCount(1)
      // Its tile, Alt-clicked, opens the lorebook in a frame beside; meanwhile it leaves the message.
      await tiles
        .first()
        .locator("a")
        .click({ modifiers: ["Alt"] })
      await expect(page.locator("[data-frame]")).toHaveCount(2)
      const work = page.getByRole("button", { name: "Work on in a workshop" })
      await expect(work).toBeVisible()
      // The editor's toolbar keeps one row in its half frame: the button follows the frame's width.
      const editor = page.locator("[data-frame]").nth(1)
      const centers = await Promise.all(
        ["History", "Make a variant", "Work on in a workshop"].map(async (name) => {
          const box = (await editor.getByRole("button", { name, exact: true }).boundingBox())!
          return Math.round(box.y + box.height / 2)
        })
      )
      expect(new Set(centers).size).toBe(1)
      await admin((api) =>
        api.SetComposerLibrary({ chatId: workshop.id, draftId: draft.id, add: [], remove: [book.id] })
      )

      await work.hover()
      await expect(tip(page)).toHaveText("Puts this in a workshop's message, so the assistant can work on it.")
      await work.click()
      const menu = page.getByRole("menu", { name: "Work on in a workshop" })
      await expect(menu.getByRole("menuitem")).toHaveText([new RegExp(`^Work ${theme}`), /^A new workshop/])
      await menu.getByRole("menuitem", { name: `Work ${theme}` }).hover()
      await shot("menu")
      await expectLayout(page, info, `workon-menu-${width}-${theme}`, { scope: "[role=menu]" })
      await menu.getByRole("menuitem", { name: `Work ${theme}` }).click()
      await expect(tiles).toHaveCount(1)
      await expect(tiles.first()).toHaveAttribute("data-library-tile", book.id)
      // Its composer has focus, to say what to do with it.
      await expect(page.getByLabel("Message", { exact: true })).toBeFocused()
      await shot("attached")
    })

  for (const [width, theme] of [
    [1340, "dark"],
    [390, "dark"],
    [390, "light"]
  ] as const)
    test(`A new workshop carries the item in its first message, at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(150_000)
      await setUp(page, width, theme)
      const shot = shooter(page, width, theme)
      const tag = `${width} ${theme}`
      const book = await admin((api) => api.CreateLorebook({ label: `Reef notes ${tag}` }))
      await page.goto(`${server().url}/library/${book.id}`)
      await page.getByRole("button", { name: "Work on in a workshop" }).click()
      const menu = page.getByRole("menu", { name: "Work on in a workshop" })
      // No workshop open in this browser tab: only a new one.
      await expect(menu.getByRole("menuitem")).toHaveText([/^A new workshop/])
      await menu.getByRole("menuitem", { name: "A new workshop" }).click()

      await expect(page).toHaveURL(/\/new\/workshop\?workshopAttach=/)
      const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
      await expect(tiles).toHaveCount(1)
      await expect(tiles.first()).toHaveAttribute("data-library-tile", book.id)
      await shot("new")
      await expectLayout(page, info, `workon-new-${width}-${theme}`, { scope: '[aria-label="Attachments"]' })

      await page.getByLabel("Message", { exact: true }).fill("Sort these out.")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
      const message = page.getByRole("article").filter({ hasText: "Sort these out." })
      const sent = message.getByLabel("Attached from your library").locator("[data-library-tile]")
      await expect(sent).toHaveCount(1)
      await expect(sent.first()).toHaveAttribute("data-library-tile", book.id)
      await shot("sent")
    })

  test("a reload before the new workshop's composer has the item keeps it", async ({ page }) => {
    await setUp(page, 1340, "dark")
    const book = await admin((api) => api.CreateLorebook({ label: "Tide tables" }))
    // The first SetComposerLibrary never reaches the server (a slow connection, say).
    let held = true
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (held && typeof data === "string" && data.includes('"SetComposerLibrary"')) return
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await page.goto(`${server().url}/library/${book.id}`)
    await page.getByRole("button", { name: "Work on in a workshop" }).click()
    await page
      .getByRole("menu", { name: "Work on in a workshop" })
      .getByRole("menuitem", { name: "A new workshop" })
      .click()
    await expect(page).toHaveURL(/[?&]draft=/)
    await expect(page.getByLabel("Message", { exact: true })).toBeEditable()
    // Not on the server yet: the URL still says what to hand over.
    await page.waitForTimeout(1000)
    expect(page.url()).toContain("workshopAttach=")
    held = false
    await page.reload()
    const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
    await expect(tiles).toHaveCount(1)
    await expect(tiles.first()).toHaveAttribute("data-library-tile", book.id)
    await expect(page).not.toHaveURL(/workshopAttach=/)
  })

  test("a handover past the limit says so and doesn't hold Send (rev-dd3 #7)", async ({ page }) => {
    test.setTimeout(120_000)
    await setUp(page, 1340, "dark")
    // One login for all of them: the server throttles logins.
    const books = await admin((api) =>
      Effect.forEach(
        Array.from({ length: 17 }, (_, i) => i),
        (i) => Effect.map(api.CreateLorebook({ label: `Chart ${i}` }), (book) => book.id)
      )
    )
    await page.goto(`${server().url}/new/workshop?workshopAttach=${books.join(",")}`)
    await expect(page).toHaveURL(/[?&]draft=/)
    await page.getByLabel("Message", { exact: true }).fill("Sort the charts.")
    await expect(page.getByText("A message can carry at most 16 cards, lorebooks and presets.")).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByRole("button", { name: /^Send( as .+)?$/ })).toBeEnabled({ timeout: 10_000 })
  })

  test("a handover the server failed once is tried again, and the first send carries it (rev-dfu1 #5)", async ({
    page
  }) => {
    test.setTimeout(120_000)
    await setUp(page, 1340, "dark")
    const book = await admin((api) => api.CreateLorebook({ label: "Buoy charts" }))
    // The first SetComposerLibrary fails (a dropped connection, say).
    let failed = false
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: unknown }) : null
        if (!failed && request?.tag === "SetComposerLibrary") {
          failed = true
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: {
                _tag: "Failure",
                cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Connection dropped" } }]
              }
            })
          )
          return
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await page.goto(`${server().url}/library/${book.id}`)
    await page.getByRole("button", { name: "Work on in a workshop" }).click()
    await page
      .getByRole("menu", { name: "Work on in a workshop" })
      .getByRole("menuitem", { name: "A new workshop" })
      .click()
    await expect(page).toHaveURL(/[?&]draft=/)
    await expect.poll(() => failed).toBe(true)
    await page.getByLabel("Message", { exact: true }).fill("Sort the charts.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
    const message = page.getByRole("article").filter({ hasText: "Sort the charts." })
    const sent = message.getByLabel("Attached from your library").locator("[data-library-tile]")
    await expect(sent).toHaveCount(1)
    await expect(sent.first()).toHaveAttribute("data-library-tile", book.id)
  })

  test("after a reload whose read of the attached items failed, the first send still carries them (rev-dd3 #6)", async ({
    page
  }) => {
    test.setTimeout(120_000)
    await setUp(page, 1340, "dark")
    const book = await admin((api) => api.CreateLorebook({ label: "Tide tables" }))
    // Armed for the reload: its first GetComposerLibrary fails.
    let armed = false
    let failed = false
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: unknown }) : null
        if (armed && !failed && request?.tag === "GetComposerLibrary") {
          failed = true
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: {
                _tag: "Failure",
                cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Connection dropped" } }]
              }
            })
          )
          return
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await page.goto(`${server().url}/new/workshop?workshopAttach=${book.id}`)
    await expect(page).toHaveURL(/[?&]draft=/)
    await expect(page).not.toHaveURL(/workshopAttach/, { timeout: 15_000 })
    armed = true
    await page.reload()
    await expect.poll(() => failed).toBe(true)
    await page.getByLabel("Message", { exact: true }).fill("Read the tides.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
    const message = page.getByRole("article").filter({ hasText: "Read the tides." })
    const sent = message.getByLabel("Attached from your library").locator("[data-library-tile]")
    await expect(sent).toHaveCount(1)
  })

  test("a new workshop swept while its handover was retrying hands it to the one opened in its place (rev-dd3 #5)", async ({
    page
  }) => {
    test.setTimeout(120_000)
    await setUp(page, 1340, "dark")
    const book = await admin((api) => api.CreateLorebook({ label: "Lighthouse logs" }))
    // The adds fail while `failing`; while `offline`, the page can't connect at all.
    let failing = true
    let offline = false
    let failures = 0
    const sockets: Array<{ close: () => Promise<void> }> = []
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      if (offline) return void socket.close()
      sockets.push(socket)
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: unknown }) : null
        if (failing && request?.tag === "SetComposerLibrary") {
          failures++
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: {
                _tag: "Failure",
                cause: [{ _tag: "Fail", error: { _tag: "ServerError", message: "Connection dropped" } }]
              }
            })
          )
          return
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await page.goto(`${server().url}/new/workshop?workshopAttach=${book.id}`)
    await expect(page).toHaveURL(/[?&]draft=/)
    const first = new URL(page.url()).searchParams.get("draft")!
    await expect.poll(() => failures).toBeGreaterThan(0)
    // The page goes offline; meanwhile its workshop is swept (another device's doing).
    offline = true
    for (const socket of sockets.splice(0)) await socket.close()
    await admin((api) => api.LeaveDraftChat({ chatId: first as never }))
    await expect
      .poll(
        () =>
          admin((api) =>
            Effect.match(api.GetChat({ chatId: first as never }), { onFailure: () => "gone", onSuccess: () => "there" })
          ),
        {
          timeout: 20_000
        }
      )
      .toBe("gone")
    failing = false
    offline = false
    // Back online: a new workshop opens in its place, with the item still to hand over.
    await expect.poll(() => new URL(page.url()).searchParams.get("draft"), { timeout: 30_000 }).not.toBe(first)
    await page.getByLabel("Message", { exact: true }).fill("Log the lamp.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
    const message = page.getByRole("article").filter({ hasText: "Log the lamp." })
    await expect(message.getByLabel("Attached from your library").locator("[data-library-tile]")).toHaveCount(1)
  })

  for (const removed of [false, true])
    test(`a new workshop swept after its handover reached the server ${removed ? "leaves an item removed since out" : "hands it to the one opened in its place"} (rev-dd4a #2)`, async ({
      page
    }) => {
      test.setTimeout(120_000)
      await setUp(page, 1340, "dark")
      const book = await admin((api) => api.CreateLorebook({ label: removed ? "Harbour rules" : "Harbour charts" }))
      // While `offline`, the page can't connect at all.
      let offline = false
      const sockets: Array<{ close: () => Promise<void> }> = []
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        if (offline) return void socket.close()
        sockets.push(socket)
        const upstream = socket.connectToServer()
        socket.onMessage((data) => upstream.send(data))
        upstream.onMessage((data) => socket.send(data))
      })
      await page.goto(`${server().url}/new/workshop?workshopAttach=${book.id}`)
      await expect(page).toHaveURL(/[?&]draft=/)
      const first = new URL(page.url()).searchParams.get("draft")!
      // The server has it: its tile shows, and the URL no longer names it.
      const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
      await expect(tiles).toHaveCount(1)
      await expect(page).not.toHaveURL(/workshopAttach=/, { timeout: 15_000 })
      if (removed) {
        // The X shows on hover or focus: by keyboard, as the tile row lets.
        await page.getByRole("button", { name: "Remove Harbour rules" }).focus()
        await page.keyboard.press("Enter")
        await expect(tiles).toHaveCount(0)
        await page.waitForTimeout(500)
      }
      // The page goes offline (a laptop asleep); meanwhile its workshop is swept.
      offline = true
      for (const socket of sockets.splice(0)) await socket.close()
      // One login for the leave and the wait: the server throttles logins.
      const swept = await admin((api) =>
        Effect.gen(function* () {
          yield* api.LeaveDraftChat({ chatId: first as never })
          for (let i = 0; i < 80; i++) {
            const gone = yield* Effect.match(api.GetChat({ chatId: first as never }), {
              onFailure: () => true,
              onSuccess: () => false
            })
            if (gone) return true
            yield* Effect.sleep(250)
          }
          return false
        })
      )
      expect(swept).toBe(true)
      offline = false
      // Back online: a new workshop opens in its place, with what was handed over and not removed.
      await expect.poll(() => new URL(page.url()).searchParams.get("draft"), { timeout: 30_000 }).not.toBe(first)
      await page.getByLabel("Message", { exact: true }).fill("Chart the harbour.")
      await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
      await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
      const message = page.getByRole("article").filter({ hasText: "Chart the harbour." })
      await expect(message).toBeVisible()
      await expect(message.getByLabel("Attached from your library").locator("[data-library-tile]")).toHaveCount(
        removed ? 0 : 1
      )
    })

  test("an item another tab removed before the sweep isn't carried on to the replacement (rev-dd5 #2)", async ({
    page,
    context
  }) => {
    test.setTimeout(120_000)
    await setUp(page, 1340, "dark")
    const book = await admin((api) => api.CreateLorebook({ label: "Harbour notices" }))
    let offline = false
    const sockets: Array<{ close: () => Promise<void> }> = []
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      if (offline) return void socket.close()
      sockets.push(socket)
      const upstream = socket.connectToServer()
      socket.onMessage((data) => upstream.send(data))
      upstream.onMessage((data) => socket.send(data))
    })
    await page.goto(`${server().url}/new/workshop?workshopAttach=${book.id}`)
    await expect(page).toHaveURL(/[?&]draft=/)
    const first = new URL(page.url()).searchParams.get("draft")!
    const tiles = page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
    await expect(tiles).toHaveCount(1)
    await expect(page).not.toHaveURL(/workshopAttach=/, { timeout: 15_000 })
    // This tab goes offline; another opens the same workshop and removes the item there.
    offline = true
    for (const socket of sockets.splice(0)) await socket.close()
    const other = await context.newPage()
    await other.setViewportSize({ width: 1340, height: 900 })
    await other.goto(page.url())
    const there = other.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")
    await expect(there).toHaveCount(1)
    await other.getByRole("button", { name: "Remove Harbour notices" }).focus()
    await other.keyboard.press("Enter")
    await expect(there).toHaveCount(0)
    await other.waitForTimeout(500)
    await other.close()
    // Then the workshop is swept; one login for the leave and the wait (logins are throttled).
    const swept = await admin((api) =>
      Effect.gen(function* () {
        yield* api.LeaveDraftChat({ chatId: first as never })
        for (let i = 0; i < 80; i++) {
          const gone = yield* Effect.match(api.GetChat({ chatId: first as never }), {
            onFailure: () => true,
            onSuccess: () => false
          })
          if (gone) return true
          yield* Effect.sleep(250)
        }
        return false
      })
    )
    expect(swept).toBe(true)
    offline = false
    await expect.poll(() => new URL(page.url()).searchParams.get("draft"), { timeout: 30_000 }).not.toBe(first)
    await page.getByLabel("Message", { exact: true }).fill("Post the notices.")
    await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
    await expect(page).toHaveURL(/\/chats\//, { timeout: 30_000 })
    const message = page.getByRole("article").filter({ hasText: "Post the notices." })
    await expect(message).toBeVisible()
    await expect(message.getByLabel("Attached from your library").locator("[data-library-tile]")).toHaveCount(0)
  })

  test("a card's More menu has it as a submenu", async ({ page }) => {
    await setUp(page, 1340, "dark")
    const card = await admin((api) =>
      api.CreateCard({ label: "Gull Keeper", name: "Gull Keeper", description: "Sorts." })
    )
    await page.goto(`${server().url}/library`)
    await page.getByRole("button", { name: `More actions for ${card.label}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Work on in a workshop" }).click()
    const sub = page.getByRole("menu", { name: "Work on in a workshop" })
    await sub.getByRole("menuitem", { name: "A new workshop" }).click()
    await expect(page).toHaveURL(/\/new\/workshop\?workshopAttach=/)
    await expect(page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile]")).toHaveCount(1)
    await expect(
      page.getByLabel("Attachments", { exact: true }).locator("[data-library-tile] span.truncate")
    ).toHaveText("Gull Keeper")
  })
})
