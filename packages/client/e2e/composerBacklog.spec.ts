import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { pickPendingPersona } from "./support/cast.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "10", FAKE_GENERATOR_TOKENS: "2000" })
let cookie: Promise<string> | null = null
const rpc = async <A>(run: (client: Client) => Effect.Effect<A, unknown>) => {
  cookie ??= loginCookie(server(), ADMIN.handle, ADMIN.password)
  return withCookie(server(), await cookie, run)
}
const toggle = async (page: Page, value: boolean) => {
  const control = page.getByRole("switch", { name: "Guidance", exact: true })
  await expect(control).toBeEnabled()
  if ((await control.getAttribute("aria-checked")) !== String(value)) await control.click()
  await expect(control).toHaveAttribute("aria-checked", String(value))
}
const importCard = async (page: Page, name: string) => {
  const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name, description: "A synthetic harbor dweller.", first_mes: "Welcome, {{user}}." }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return rpc((api) => api.ListCards()).then((cards) => cards.find((card) => card.name === name)!.entityId)
}

for (const [width, theme, model, asCard] of [
  [1440, "light", false, false],
  [1440, "dark", true, false],
  [390, "light", false, true],
  [390, "dark", true, true]
] as const) {
  test(`composer backlog ${width} ${theme}: ${model ? "model" : "human"} writes ${asCard ? "card" : "persona"}`, async ({
    page,
    context
  }) => {
    test.setTimeout(120_000)
    let armed = false
    let release: (() => void) | null = null
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (armed && release === null && typeof data === "string" && JSON.parse(data).tag === "EditQueued") {
          release = () => upstream.send(data)
          return
        }
        upstream.send(data)
      })
    })
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const name = `Mira ${width} ${theme}`
    const personaName = `Ana ${width} ${theme}`
    const cardId = await importCard(page, name)
    const personaId = await importCard(page, personaName)
    await rpc((api) => api.SetPersona({ entityId: personaId, persona: true }))
    await page.goto(`${server().url}/cards/${cardId}/chat`)
    await pickPendingPersona(page, personaName)
    await page.getByRole("button", { name: /^Speaking as / }).click()
    const picker = page.getByRole("dialog", { name: "Speak as", exact: true })
    await expect(picker.getByRole("option", { name, exact: true })).toBeVisible()
    await expect(picker.getByRole("option", { name: personaName, exact: true })).toBeVisible()
    await expect(picker.getByRole("option")).toHaveCount(2)
    const selected = asCard ? name : personaName
    const speakerId = asCard ? cardId : personaId
    await picker.getByRole("option", { name: selected, exact: true }).click()
    await toggle(page, model)
    const box = page.getByRole("textbox", { name: model ? "Guidance" : "Message", exact: true })
    await box.fill(model ? "Describe the harbor in this character's voice." : "I watch the harbor.")
    const shots = process.env.SCREENSHOT_DIR
    if (shots) await page.screenshot({ animations: "disabled", path: join(shots, `pending-${width}-${theme}.png`) })
    await box.press("Enter")
    await expect(page).toHaveURL(/\/chats\/[^/?]+$/)
    const chatId = page.url().split("/chats/")[1]! as ChatId
    await expect(page.getByRole("button", { name: new RegExp(`^Speaking as ${selected}`) })).toBeVisible()
    await expect(page.getByRole("button", { name: "Stop the reply", exact: true })).toHaveCount(0)
    const entries = await rpc((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 }))
    const first = entries.entries.find((entry) => entry.version.origin !== "greeting")!
    expect(first.version.speakerEntityId).toBe(speakerId)
    expect(first.version.writer).toBe(model ? "model" : "human")
    const leaf = entries.entries.at(-1)!
    // A message and its unsaved edit are separate: reloading and another device find the
    // edit without changing what the queue will post.
    const sent = await rpc((api) =>
      api.SendMessage({
        chatId,
        parentSlotId: leaf.slotId,
        branch: false,
        content: "Queued original",
        speakerEntityId: speakerId,
        reply: false
      })
    )
    expect(sent._tag).toBe("Queued")
    const queued = page.getByRole("list", { name: "Queued messages" })
    await queued.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = page.getByRole("textbox", { name: "Queued message", exact: true })
    const long = "An unfinished edit about the harbor keeper. ".repeat(8)
    await edit.fill(long)
    await expect.poll(() => rpc((api) => api.MessageDrafts({ chatId })).then((drafts) => drafts[0]?.content)).toBe(long)
    await edit.fill("x")
    await expect.poll(() => rpc((api) => api.MessageDrafts({ chatId })).then((drafts) => drafts[0]?.content)).toBe("x")
    await page.reload()
    await expect(edit).toHaveValue("x")
    const other = await context.newPage()
    await other.goto(page.url())
    await expect(other.getByRole("textbox", { name: "Queued message", exact: true })).toHaveValue("x")
    await other.close()
    await queued.getByRole("button", { name: "Earlier text of queued edit" }).click()
    await page.getByRole("button", { name: new RegExp(`^${long.length} characters`) }).click()
    await expect(edit).toHaveValue(long)
    if (shots) await page.screenshot({ animations: "disabled", path: join(shots, `queue-edit-${width}-${theme}.png`) })
    let retained = long
    if (width === 1440 && theme === "light") {
      armed = true
      await queued.getByRole("button", { name: "Save", exact: true }).click()
      await expect.poll(() => release !== null).toBe(true)
      retained = "Typed while the queue Save was on its way."
      await edit.fill(retained)
      release!()
      await expect(edit).toHaveValue(retained)
      await expect
        .poll(() => rpc((api) => api.MessageDrafts({ chatId })).then((drafts) => drafts[0]?.content))
        .toBe(retained)
    }
    // Stopping uses the running version. Queue posting keeps the unsent editor and its
    // server draft available, including on another reload.
    await page.getByRole("button", { name: "Stop", exact: true }).first().click()
    await expect(page.getByText("This queued item posted or was withdrawn.", { exact: false })).toBeVisible()
    await page.reload()
    await expect(edit).toHaveValue(retained)
    if (shots)
      await page.screenshot({ animations: "disabled", path: join(shots, `queue-recovered-${width}-${theme}.png`) })
    await queued.getByRole("button", { name: "Copy to composer" }).click()
    await expect(edit).toHaveCount(0)
    const composer = page.getByRole("textbox", { name: model ? "Guidance" : "Message", exact: true })
    await expect(composer).toHaveValue(new RegExp(retained.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    // The selected speaker also survives a saved-chat generation.
    await toggle(page, true)
    await page.getByRole("textbox", { name: "Guidance", exact: true }).fill("Now look toward the lighthouse.")
    await page.getByRole("textbox", { name: "Guidance", exact: true }).press("Enter")
    await expect
      .poll(() =>
        rpc((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })).then(
          (path) => path.entries.at(-1)?.version.speakerEntityId
        )
      )
      .toBe(speakerId as EntityId)
    await page.getByRole("button", { name: "Stop", exact: true }).first().click()
    await toggle(page, false)
    const written = `A saved-chat message from ${selected}.`
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(written)
    await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter")
    await expect
      .poll(() =>
        rpc((api) => api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })).then((path) => {
          const sent = path.entries.find((entry) => entry.version.content === written)
          return sent ? { speaker: sent.version.speakerEntityId, writer: sent.version.writer } : null
        })
      )
      .toEqual({ speaker: speakerId, writer: "human" })
    await expect(page.getByRole("button", { name: new RegExp(`^Speaking as ${selected}`) })).toBeVisible()
    await expect(page.getByRole("button", { name: "Stop", exact: true }).first()).toBeVisible()
    await page.getByRole("button", { name: "Stop", exact: true }).first().click()
  })
}

test("a running swipe outside the selected version can still be selected and stopped", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const started = await rpc((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Concurrent swipe Stop" })
      const sent = yield* api.Generate({ chatId: chat.id, parentSlotId: null, branch: false })
      if (sent._tag !== "Posted") throw new Error("expected first version to post")
      return { chat, entry: sent.entry }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  await reply.getByRole("button", { name: "Generate another version" }).click()
  await expect(reply.getByRole("group", { name: "Versions" })).toContainText("2/2")
  await reply.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(reply.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect
    .poll(() =>
      rpc((api) => api.ListVersions({ slotId: started.entry.slotId })).then((versions) => versions[0]?.status)
    )
    .toBe("generating")
  await reply.getByRole("button", { name: "Version 2 of 2: choose a version" }).click()
  await page.getByRole("button", { name: /^Version 1,/ }).click()
  await reply.getByRole("button", { name: "Stop", exact: true }).click()
  await expect
    .poll(() =>
      rpc((api) => api.ListVersions({ slotId: started.entry.slotId })).then((versions) =>
        versions.map((version) => version.status)
      )
    )
    .toEqual(["stopped", "stopped"])
  await expect(page.getByRole("button", { name: "Stop the reply", exact: true })).toHaveCount(0)
})

test("a reply longer than a phone's screen keeps its Stop in view while it's written", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 390, height: 600 })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const started = await rpc((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Long reply Stop" })
      const sent = yield* api.Generate({ chatId: chat.id, parentSlotId: null, branch: false })
      if (sent._tag !== "Posted") throw new Error("expected the reply to post")
      return { chat, entry: sent.entry }
    })
  )
  await page.goto(`${server().url}/chats/${started.chat.id}`)
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  const stop = reply.getByRole("button", { name: "Stop", exact: true })
  // Taller than the screen: its start, where Stop used to be, has scrolled away.
  await expect.poll(async () => (await reply.boundingBox())?.height ?? 0, { timeout: 90_000 }).toBeGreaterThan(700)
  await expect(reply.locator("header")).not.toBeInViewport()
  await expect(stop).toBeInViewport()
  // Read from further up, the reply's end is below the screen, and Stop stays at its bottom.
  await page.mouse.move(195, 300)
  await page.mouse.wheel(0, -250)
  await expect(stop).toBeInViewport()
  await stop.click()
  await expect
    .poll(() => rpc((api) => api.ListVersions({ slotId: started.entry.slotId })).then((v) => v[0]?.status))
    .toBe("stopped")
  await expect(stop).toHaveCount(0)
})

test("a pending guidance action fits a long speaker name on a phone and desktop", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  const name = "Keeper of the Northern Lighthouse and the Harbor of Many Returning Ships"
  const cardId = await importCard(page, name)
  await page.goto(`${server().url}/cards/${cardId}/chat`)
  await page.getByRole("button", { name: /^Speaking as / }).click()
  await page.getByRole("dialog", { name: "Speak as", exact: true }).getByRole("option", { name, exact: true }).click()
  await toggle(page, true)
  const generate = page.getByRole("button", { name: `Write for ${name}`, exact: true })
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((value) => {
        localStorage.setItem("rp.theme", value)
        document.documentElement.dataset.theme = value
      }, theme)
      const bounds = await generate.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await expect(page.getByRole("switch", { name: "Guidance", exact: true })).toBeInViewport()
      const shots = process.env.SCREENSHOT_DIR
      if (shots)
        await page.screenshot({ animations: "disabled", path: join(shots, `pending-long-${width}-${theme}.png`) })
    }
  }
})
