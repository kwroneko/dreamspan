// Unavailable controls retain their boxes and explain why (owner, 2026-11-02).
import { expect, test, type Locator, type Page } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { showActions } from "./support/message.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { saveCluster } from "./support/saveRevision.ts"
import { cardFieldsTab } from "./support/cardEditor.ts"
import { openPanel } from "./support/panel.ts"
import { level1 } from "./support/summaries.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "40", FAKE_GENERATOR_TOKENS: "4000" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
test.use({ reducedMotion: "reduce" })
test.beforeEach(async () => {
  if (process.env.STABLE_BUTTONS_AUDIT) test.setTimeout(180_000)
})

// Positions relative to the containing strip exclude scrolling when the editor gains focus.
const boxes = (row: Locator) =>
  row.evaluate((row) => {
    const root = row.getBoundingClientRect()
    return [...row.querySelectorAll("button, a")]
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => {
        const r = e.getBoundingClientRect()
        const left =
          row.getAttribute("aria-label") === "Message actions"
            ? row.closest("article")!.getBoundingClientRect().x
            : root.x
        return { x: r.x - left, y: r.y - root.y, width: r.width, height: r.height }
      })
  })
const hint = async (page: Page, button: Locator, text: string) => {
  await page.mouse.move(0, 0)
  await button.hover()
  await expect(page.getByText(text, { exact: false }).filter({ visible: true }).last()).toBeVisible()
  await page.mouse.move(0, 0)
}
const audit = async (page: Page, surface: string) => {
  if (process.env.STABLE_BUTTONS_AUDIT) await expectLayout(page, test.info(), surface)
}

for (const width of [1440, 390]) {
  test(`field history, text actions and Revert keep their boxes at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const card = await admin((api) => api.CreateCard({ label: `Stable ${width}`, name: `Stable ${width}` }))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/library/${card.id}`)
    for (const label of ["Description", "Creator"]) {
      if (label === "Creator") await cardFieldsTab(page, "Metadata")
      const box = page.getByRole("textbox", { name: label, exact: true })
      const frame = page.locator("[data-field-frame]").filter({ has: box })
      await box.scrollIntoViewIfNeeded()
      await box.focus()
      const chrome = frame.locator("[data-field-chrome]")
      const history = chrome.getByRole("button", { name: `Edit history of ${label}`, exact: true })
      await expect(history).toBeDisabled()
      await hint(page, history, "No edit history yet.")
      const before = await boxes(chrome)
      const cluster = saveCluster(page).first()
      const revert = cluster.getByRole("button", { name: "Revert", exact: true })
      await expect(revert).toBeDisabled()
      const saved = await boxes(cluster)
      if (label === "Description") {
        const send = chrome.getByRole("button", { name: "Send text to snippet", exact: true })
        await expect(send).toBeDisabled()
        await hint(page, send, "No text to send yet.")
      }
      await box.fill("Synthetic text.")
      await expect(history).toBeEnabled()
      expect(await boxes(chrome)).toEqual(before)
      await expect(revert).toBeEnabled()
      expect(await boxes(cluster)).toEqual(saved)
      await audit(page, `field-${label}-${width}`)
      await cluster.getByRole("button", { name: "Save", exact: true }).click()
      await expect(revert).toBeDisabled()
      expect(await boxes(cluster)).toEqual(saved)
    }
  })

  test(`connection key actions and model-limit pencils retain their boxes at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const { connection } = await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: `Keys ${width}`,
            baseUrl: "http://127.0.0.1:9/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        yield* api.AddUserModel({ connectionId: connection.id, key: "synthetic", overrides: {} })
        return { connection }
      })
    )
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/settings/connections/${connection.id}`)
    const enter = page.getByRole("button", { name: "Enter a new key", exact: true })
    const row = enter.locator("..")
    const remove = page.getByRole("button", { name: "Remove key", exact: true })
    await expect(remove).toBeDisabled()
    await remove.scrollIntoViewIfNeeded()
    await hint(page, remove, "This connection has no key to remove.")
    const before = await boxes(row)
    await enter.click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Key", { exact: true }).fill("sk-synthetic-123456")
    await dialog.getByRole("button", { name: "Save key", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(remove).toBeEnabled()
    expect(await boxes(row)).toEqual(before)
    await audit(page, `connection-keys-${width}`)
    await page.getByRole("button", { name: "Edit synthetic", exact: true }).click()
    const model = page.getByRole("dialog")
    const pencil = model.getByRole("button", { name: "Set the output limit yourself", exact: true })
    const limitRow = pencil.locator("..")
    const limitBefore = await boxes(limitRow)
    await pencil.click()
    await expect(pencil).toBeDisabled()
    expect(await boxes(limitRow)).toEqual(limitBefore)
    await hint(page, pencil, "This limit is already open for editing.")
    await audit(page, `model-limit-${width}`)
  })

  test(`message, queue, version, branch and composer controls stay present at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    const chat = await admin((api) => api.CreateChat({ title: `Controls ${width}` }))
    await admin((api) => api.SetDisplayPrefs({ prefs: { messageToolbar: { "message.delete-all": true } } }))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    const branch = page.getByRole("button", { name: /^Branch:.*switch branch$/ })
    await expect(branch).toBeDisabled()
    await hint(page, branch, "No other branches yet.")
    // No dead cache chip: before any estimate there is none.
    await expect(page.getByRole("button", { name: /^Cache/ })).toHaveCount(0)
    const composer = page.getByTestId("composer-controls")
    const guidance = composer.getByRole("switch", { name: "Guidance", exact: true })
    const send = composer.getByRole("button", { name: "Send", exact: true })
    // Empty, Send would pass the turn (no one here can reply).
    await expect(send).toBeDisabled()
    await hint(page, send, "Type a message to send.")
    // With guidance on, Generate is the one action, in Generate's and Send's room: nothing else moves
    // (owner, 2026-11-23; guidanceButtons.spec.ts checks the widths).
    const before = (await boxes(composer)).slice(0, -3)
    const toggleBox = await guidance.boundingBox()
    await guidance.click()
    await expect(send).toHaveCount(0)
    expect(await guidance.boundingBox()).toEqual(toggleBox)
    await page.getByTestId("composer").fill("Synthetic guidance.")
    expect((await boxes(composer)).slice(0, -2)).toEqual(before)
    expect(await guidance.boundingBox()).toEqual(toggleBox)
    await audit(page, `composer-${width}`)
    await guidance.click()
    await page.getByLabel("Message", { exact: true }).fill("Synthetic first message.")
    await send.click()
    const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
    await expect(reply).toBeVisible()
    await showActions(reply)
    const bar = reply.getByRole("toolbar", { name: "Message actions" })
    const edit = bar.getByRole("button", { name: "Edit", exact: true })
    await expect(edit).toBeDisabled()
    const pinnedBefore = await boxes(bar)
    await page.getByLabel("Message", { exact: true }).fill("Synthetic queued message.")
    await send.click()
    const queue = page.getByRole("list", { name: "Queued messages" })
    const queueEdit = queue.getByRole("button", { name: "Edit", exact: true })
    const queueRow = queueEdit.locator("..")
    const queueBefore = await boxes(queueRow)
    await queueEdit.click()
    await expect(queueEdit).toBeDisabled()
    expect(await boxes(queueRow)).toEqual(queueBefore)
    await hint(page, queueEdit, "This queued message is already open for editing.")
    await audit(page, `queue-${width}`)
    await queue.getByRole("button", { name: "Withdraw", exact: true }).click()
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    await showActions(reply)
    await expect(edit).toBeEnabled()
    expect(await boxes(bar)).toEqual(pinnedBefore)
    const versions = reply.getByRole("group", { name: "Swipes", exact: true })
    const versionsBefore = await boxes(versions)
    await hint(page, versions.getByRole("button", { name: /choose a swipe/ }), "No other swipes yet.")
    await expect(versions.getByRole("button", { name: "Previous swipe", exact: true })).toBeDisabled()
    await versions.getByRole("button", { name: "Generate another swipe", exact: true }).click()
    await expect(versions).toContainText("2/2")
    expect(await boxes(versions)).toEqual(versionsBefore)
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    await showActions(reply)
    const deleteAll = bar.getByRole("button", { name: "Delete all swipes", exact: true })
    await expect(deleteAll).toBeEnabled()
    const beforeDelete = await boxes(bar)
    await bar.getByRole("button", { name: "Delete swipe", exact: true }).click()
    await expect(deleteAll).toBeDisabled()
    expect(await boxes(bar)).toEqual(beforeDelete)
    await audit(page, `message-versions-${width}`)
    const path = await admin((api) =>
      api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    )
    await admin((api) =>
      api.CreateFork({
        chatId: chat.id,
        fromForkId: chat.currentForkId,
        atSlotId: path.entries[0]!.slotId,
        name: "Second"
      })
    )
    await expect(branch).toBeEnabled()
    await audit(page, `branch-${width}`)
  })

  test(`next-reply controls stay disabled until there is a choice at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const chat = await admin((api) => api.CreateChat({ title: `Next controls ${width}` }))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${chat.id}`)
    const strip = page.getByRole("group", { name: "Next reply", exact: true })
    const next = strip.getByRole("button", { name: /^Next:.*Choose who replies next$/ })
    await expect(next).toBeDisabled()
    await expect(strip.getByRole("button", { name: /^Prompt preset: / })).toBeVisible()
    await expect(strip.getByRole("button", { name: /^(Choose a model$|Model: )/ })).toBeVisible()
    // The chips have their values, not the "…" they show while loading.
    await expect(strip.getByRole("button", { name: /: loading$/ })).toHaveCount(0)
    // The model and preset chips, after Next (whose label names who replies): their sizes hold.
    const sizes = async () => (await boxes(strip)).slice(1, 3).map(({ width, height }) => ({ width, height }))
    const before = await sizes()
    await admin((api) =>
      Effect.gen(function* () {
        for (const name of ["Mira", "Wren"]) {
          const card = yield* api.CreateCard({ label: `${name} ${width}`, name })
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        }
      })
    )
    await expect(next).toBeEnabled()
    expect(await sizes()).toEqual(before)
    // Next, model and preset: Reply now is the empty Send, Auto replies are in the Cast tab, and
    // with no model there's no request to size or cache, so no context or cache chip.
    await expect(strip.locator("button")).toHaveCount(3)
    const controls = page.getByTestId("composer-controls")
    const emptySend = controls.getByRole("button", { name: / repl(?:y|ies)$/ })
    await expect(emptySend).toBeVisible()
    // With guidance on, Generate is the one action (owner, 2026-11-23): no empty Send beside it.
    await controls.getByRole("switch", { name: "Guidance", exact: true }).click()
    await expect(emptySend).toHaveCount(0)
    await expect(controls.getByRole("button", { name: /^Generate/ })).toBeEnabled()
    await audit(page, `next-reply-${width}`)
  })

  test(`pending composer's guidance toggle stays put as Generate takes Send's room at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const card = await admin((api) => api.CreateCard({ label: `Pending ${width}`, name: `Pending ${width}` }))
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/cards/${card.entityId}/chat`)
    await page.getByTestId("composer").fill("A synthetic first turn.")
    const controls = page.getByTestId("composer-controls")
    const send = controls.getByRole("button", { name: /^Send/ })
    await expect(send).toBeEnabled()
    const before = (await boxes(controls)).slice(0, -2)
    await controls.getByRole("switch", { name: "Guidance", exact: true }).click()
    await expect(send).toHaveCount(0)
    expect((await boxes(controls)).slice(0, -1)).toEqual(before)
    await audit(page, `pending-composer-${width}`)
  })

  test(`summary header controls remain while editing at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const fixture = await admin((api) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateChat({ title: `Summary controls ${width}` })
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Synthetic summary input."
        })
        if (sent._tag !== "Posted") throw new Error("expected posted")
        return { chat, entry: sent.entry }
      })
    )
    const summary = await level1(server().dataDir, fixture.chat.id, [fixture.entry], "A synthetic event.")
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    await page.goto(`${server().url}/chats/${fixture.chat.id}`)
    const panel = await openPanel(page, "Summaries")
    const row = panel.locator(`[data-summary="${summary.id}"]`)
    const edit = row.getByRole("button", { name: "Edit the summary of message 1", exact: true })
    const actions = edit.locator("..")
    const before = await boxes(actions)
    await edit.click()
    await expect(edit).toBeDisabled()
    expect(await boxes(actions)).toEqual(before)
    await hint(page, edit, "This summary is already open for editing.")
    await audit(page, `summary-edit-${width}`)
  })
}
