// The save cluster (ui/SaveControls, DESIGN §10.1), on a card's library page: each state shows
// on Save and in its explanation, never as text beside it; the cluster keeps one size through
// all of them; both buttons are reached by keyboard, their explanations shown on focus. Saving
// is held, and a failure made, by catching the save on its way to the server. In the chat's
// panel, it shares each surface's toolbar row and keeps its size. Everything here is made up.
import { switchAll } from "./support/lorebook.ts"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { openPanel, panelTab } from "./support/panel.ts"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, saveCluster } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

const upload = async (page: Page, name: string) => {
  const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
    data: Buffer.from(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: { name, description: "Keeps the ledger.", first_mes: "The lamp turns." }
      })
    ),
    headers: { origin: server().url, "content-type": "application/octet-stream" }
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id
}

/** The explanation a control shows on hover and focus: its accessible description. */
const explanation = (control: Locator) =>
  control.evaluate((element) => {
    const id = element.getAttribute("aria-describedby")
    return id === null ? "" : (document.getElementById(id)?.textContent ?? "")
  })

for (const width of [1440, 390])
  test(`the save cluster's states, size and keyboard at ${width}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    let mode: "pass" | "hold" | "fail" = "pass"
    const held: Array<() => void> = []
    await page.routeWebSocket(/\/rpc$/, (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        if (typeof data === "string" && data.includes('"CommitEditorDrafts"')) {
          if (mode === "hold") return void held.push(() => upstream.send(data))
          if (mode === "fail") {
            const frame = JSON.parse(data)
            frame.payload.refId = "00000000-0000-0000-0000-000000000000"
            return upstream.send(JSON.stringify(frame))
          }
        }
        upstream.send(data)
      })
      upstream.onMessage((data) => socket.send(data))
    })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const refId = await upload(page, `Mira ${width}`)
    await page.goto(`${server().url}/library/${refId}`)

    const cluster = saveCluster(page).first()
    const save = cluster.getByRole("button", { name: "Save", exact: true })
    const withMessage = cluster.getByRole("button", { name: "Save with a message…", exact: true })
    const revert = cluster.getByRole("button", { name: "Revert to the last save", exact: true })
    const description = page.getByRole("textbox", { name: "Description", exact: true })
    const sizes: Array<{ state: string; width: number; height: number }> = []
    const measure = async (state: string) => {
      const box = (await cluster.boundingBox())!
      sizes.push({ state, width: box.width, height: box.height })
    }
    const edit = async (text: string) => {
      await description.click()
      await page.keyboard.press("Control+End")
      await page.keyboard.insertText(text)
    }

    // Nothing to save: quiet, not actionable, saying why; no state text beside it.
    await expect(cluster).toHaveAttribute("data-save-state", "clean")
    await expect(save).toBeDisabled()
    await expect(withMessage).toBeDisabled()
    await expect(revert).toBeVisible()
    await expect(revert).toBeDisabled()
    await expect(cluster).not.toContainText(/revision/i)
    expect(await explanation(save)).toMatch(/^Nothing to save/)
    await measure("clean")

    // Unsaved: Save is actionable, and so is Revert.
    await edit(" Counts the gulls.")
    await expect(cluster).toHaveAttribute("data-save-state", "unsaved", { timeout: 30_000 })
    await expect(save).toBeEnabled()
    await expect(withMessage).toBeEnabled()
    await expect(revert).toBeEnabled()
    expect(await explanation(save)).toMatch(/History.*already in use/)
    expect(await explanation(withMessage)).toMatch(/note saying what changed/)
    await measure("unsaved")

    // Keyboard: Save, then Save with a message, each explained on focus.
    await save.focus()
    await expect(
      page.getByText(/^Keeps this version in History so you can return to it/).filter({ visible: true })
    ).toBeVisible()
    await page.keyboard.press("Tab")
    await expect(withMessage).toBeFocused()
    await expect(page.getByText(/^Keeps this version in History with a note/).filter({ visible: true })).toBeVisible()
    await page.keyboard.press("Tab")
    await expect(revert).toBeFocused()

    // Saving: brief progress on Save itself.
    mode = "hold"
    await save.click()
    await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1)
    await expect(cluster).toHaveAttribute("data-save-state", "saving")
    await expect(save).toHaveAttribute("aria-busy", "true")
    await measure("saving")
    mode = "pass"
    held.shift()!()

    // Just saved: a tick that settles back to quiet.
    await expect(cluster).toHaveAttribute("data-save-state", "saved", { timeout: 30_000 })
    await expect(cluster.getByRole("status")).toHaveText("Saved")
    await measure("saved")
    await expect(cluster).toHaveAttribute("data-save-state", "clean", { timeout: 10_000 })
    await measure("settled")

    // Failed: Save says so, the reason in its explanation, and saving again works.
    await edit(" And the ships.")
    await expect(cluster).toHaveAttribute("data-save-state", "unsaved", { timeout: 30_000 })
    mode = "fail"
    await save.click()
    await expect(cluster).toHaveAttribute("data-save-state", "failed", { timeout: 30_000 })
    mode = "pass"
    await expect(save).toBeEnabled()
    expect(await explanation(save)).toMatch(/^Couldn't save: .+ Save again to retry\.$/)
    await expect(cluster.getByRole("status")).toHaveText(/^Couldn't save/)
    await measure("failed")
    await save.click()
    await expect(cluster).toHaveAttribute("data-save-state", NOTHING_TO_SAVE, { timeout: 30_000 })

    // One size through every state.
    for (const size of sizes) expect(size, size.state).toEqual({ ...sizes[0]!, state: size.state })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  })

for (const width of [1440, 390])
  test(`the save cluster shares each panel surface's toolbar row and keeps its size at ${width}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: 900 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const name = `Wren ${width}`
    await upload(page, name)
    const book = await page.request.post(`${server().url}/library/import?name=Tides${width}.json`, {
      data: Buffer.from(
        JSON.stringify({
          name: `Tides ${width}`,
          entries: { 0: { uid: 0, key: ["tide"], comment: "Tides", content: "Twice a day.", order: 1 } }
        })
      ),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(book.status()).toBe(200)
    const chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const preset = yield* api.CreatePreset({ label: `Preset ${width}` })
        yield* api.ChangeGenerationDefaults({ change: { preset: preset.id } })
        const lore = (yield* api.ListLibrary({ kind: "lorebook" })).find((r) => r.label === `Tides ${width}`)!
        const card = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === name)!
        const chat = yield* api.CreateChat({ title: `Rows ${width}` })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: null,
          change: { _tag: "Lorebook", ref: lore.id, active: true }
        })
        return chat.id
      })
    )
    await page.goto(`${server().url}/chats/${chatId}`)

    /** `beside`, a control of the surface's own toolbar, shares the cluster's row; the cluster keeps its size. */
    const check = async (surface: string, scope: Locator, beside: Locator, edit: () => Promise<void>) => {
      const cluster = saveCluster(scope).first()
      await expect(cluster).toHaveAttribute("data-save-state", "clean", { timeout: 30_000 })
      const before = (await cluster.boundingBox())!
      const other = (await beside.boundingBox())!
      expect(before.y < other.y + other.height && other.y < before.y + before.height, `${surface}: one row`).toBe(true)
      await edit()
      await expect(cluster).toHaveAttribute("data-save-state", "unsaved", { timeout: 30_000 })
      const after = (await cluster.boundingBox())!
      expect({ w: after.width, h: after.height }).toEqual({ w: before.width, h: before.height })
      await cluster.getByRole("button", { name: "Save", exact: true }).click()
      await expect(cluster).toHaveAttribute("data-save-state", NOTHING_TO_SAVE, { timeout: 30_000 })
      const saved = (await cluster.boundingBox())!
      expect({ w: saved.width, h: saved.height }).toEqual({ w: before.width, h: before.height })
    }
    const typeInto = async (box: Locator, text: string) => {
      await box.click()
      await page.keyboard.press("Control+End")
      await page.keyboard.insertText(text)
    }

    // The character tab: Save at the end of the card's tab row.
    const card = await openPanel(page, name)
    await check("card", card, card.getByRole("tab", { name: "Definition", exact: true }), () =>
      typeInto(card.getByRole("textbox", { name: "Description", exact: true }), " Counts the gulls.")
    )
    // The Prompt preset tab: Save on the left of Expand all's row.
    await panelTab(page, "Prompt preset")
    const preset = page.getByRole("tabpanel", { name: "Prompt preset", exact: true })
    await check("preset", preset, preset.getByRole("button", { name: "Expand all", exact: true }), async () => {
      await preset.getByRole("button", { name: "Expand Main Prompt", exact: true }).click()
      await typeInto(preset.getByRole("textbox", { name: "Prompt: Main Prompt", exact: true }), " Slowly.")
    })
    // A lorebook in the Lorebooks tab: Save on the left of its entries' toolbar.
    const lore = await openPanel(page, "Lorebooks")
    await lore.getByRole("button", { name: new RegExp(`^Tides ${width}`) }).click()
    const editor = lore.getByRole("region", { name: `Lorebook Tides ${width}` })
    await check("lorebook", editor, editor.getByRole("button", { name: "Add entry" }), () =>
      switchAll(editor, "Disable all")
    )
    // A note: Save in its header, beside its menu.
    const notes = await openPanel(page, "Notes")
    // Add note is a button of its own in the section header since notesheader.
    await notes
      .getByRole("region", { name: "This chat's notes" })
      .getByRole("button", { name: "Add note", exact: true })
      .click()
    const note = notes.getByRole("region", { name: "Note Note" })
    await note.getByRole("textbox", { name: /^Text of/ }).fill("A first line.")
    await saveCluster(note).getByRole("button", { name: "Save", exact: true }).click()
    await check("note", note, note.getByRole("button", { name: "Actions for Note", exact: true }), () =>
      typeInto(note.getByRole("textbox", { name: /^Text of/ }), " And a second.")
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  })
