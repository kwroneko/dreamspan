import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { textField } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { writeRealisticStFolder } from "../../server/test/support/stRealistic.ts"
import { asUser } from "./support/rpc.ts"
import { NOTHING_TO_SAVE, expectSaveState, saveButton, saveCluster, saveRevision } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectTextBox, textBoxValue } from "./support/textbox.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true })
const description = "A quiet harbor.\nThe lamp burns."
const scenario = "Day watch."
const newDescription = "A quiet harbor.\nThe lamp flickers."
const newScenario = "Night watch.\nA storm arrives."

const create = () =>
  admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label: "Code editor fixture", name: "Wren" })
      for (const [key, content] of Object.entries({ description, scenario }))
        yield* api.SaveEditorDraft({
          refId: card.id,
          field: textField([key]),
          content,
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: card.headRevisionId
        })
      const opened = yield* api.OpenEditor({ refId: card.id })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: opened.ref.rowVersion,
        fields: opened.drafts.map((draft) => ({
          field: draft.key.field,
          draftId: draft.id,
          expectedRowVersion: draft.rowVersion
        })),
        message: "Baseline"
      })
      return card.id
    })
  )
const open = async (page: Page, id: string, initial = description) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${id}`)
  await expectTextBox(field(page, "Description"), initial)
}

for (const width of [1440, 390])
  test(`card markers, a saved revision's diff and revision comparisons at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await open(page, await create())
    await field(page, "Description").fill(newDescription)
    await field(page, "Scenario").fill(newScenario)
    await expect(field(page, "Description").locator("..").locator(".rp-line-modified")).toHaveCount(1)
    await expect(field(page, "Scenario").locator("..").locator(".rp-line-added")).toHaveCount(1)
    // Save asks nothing; History's comparison shows what it saved.
    await saveRevision(page, "Night watch")
    await expectSaveState(page, NOTHING_TO_SAVE)
    await expect(page.locator(".rp-line-added, .rp-line-modified, .rp-line-deleted")).toHaveCount(0)
    await field(page, "Description").fill(`${newDescription}\nA draft after saving.`)
    await page.getByRole("button", { name: "History", exact: true }).click()
    const history = page.getByRole("dialog", { name: "History", exact: true })
    const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
    await expect(revisions).toHaveCount(3)
    await expect(revisions.first()).toContainText("Night watch")
    const messageRow = revisions.first().locator("[data-revision-message-row]")
    const editMessage = revisions.first().getByRole("button", { name: "Edit message of Revision 3", exact: true })
    await editMessage.click()
    const messageBox = history.getByRole("textbox", { name: "Message of Revision 3", exact: true })
    await messageBox.fill("Cancelled message")
    await messageBox.press("Escape")
    await expect(messageRow).toContainText("Night watch")
    const longMessage =
      "The lantern keeper records the harbor meeting and the travelers' promise to return after the evening bell. ".repeat(
        4
      )
    await editMessage.click()
    await messageBox.fill(longMessage)
    await messageBox.press("Enter")
    await expect(messageBox).toHaveCount(0)
    expect((await messageRow.boundingBox())!.height).toBe(32)
    await revisions.first().getByRole("button", { name: "Expand message of Revision 3", exact: true }).click()
    await expect(revisions.first().getByRole("region", { name: "Full message of Revision 3", exact: true })).toHaveText(
      longMessage.trim()
    )
    await editMessage.click()
    await messageBox.fill("Another cancelled message")
    await history.getByRole("button", { name: "Cancel editing message", exact: true }).click()
    await revisions.first().getByRole("button", { name: "Collapse message of Revision 3", exact: true }).click()
    await editMessage.click()
    await messageBox.fill("Night watch")
    await history.getByRole("button", { name: "Save message", exact: true }).click()
    await expect(messageBox).toHaveCount(0)
    expect((await messageRow.boundingBox())!.height).toBe(32)

    await revisions
      .first()
      .getByRole("button", { name: /^Revision \d+ / })
      .click()
    const changes = history.locator("details")
    await expect(changes).toHaveCount(2)
    await history.getByText("Description", { exact: true }).click()
    await expect(history.locator(".cm-editor").first()).toBeVisible()
    if (width > 639) {
      await expectTextBox(changes.first().getByRole("textbox", { name: "Revision 2", exact: true }), description)
      await expectTextBox(changes.first().getByRole("textbox", { name: "Revision 3", exact: true }), newDescription)
    } else {
      await expect(changes.first().locator(".cm-deletedChunk")).toContainText("The lamp burns.")
      await expectTextBox(changes.first().getByRole("textbox", { name: "Changes", exact: true }), newDescription)
    }
    await history.getByRole("tab", { name: "Changes from current state" }).click()
    await expect(changes).toHaveCount(1)
    await expect(changes.first()).toContainText("Description")
    await changes.first().locator("summary").click()
    await expectTextBox(
      changes.first().getByRole("textbox", { name: width > 639 ? "Current state" : "Changes", exact: true }),
      `${newDescription}\nA draft after saving.`
    )
    if (width > 639)
      await expectTextBox(changes.first().getByRole("textbox", { name: "Revision 3", exact: true }), newDescription)
    await revisions
      .nth(1)
      .getByRole("button", { name: /^Revision \d+ / })
      .click()
    await expect(history.getByRole("tab", { name: "Changes from previous revision" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await expect(changes).toHaveCount(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  })

test("changes propagate exactly, native undo works, and external replacements do not echo", async ({ page }) => {
  const id = await create()
  await open(page, id)
  const box = field(page, "Description")
  await box.click()
  await box.press("ControlOrMeta+End")
  await box.pressSequentially(" A new thought.")
  await expectTextBox(box, `${description} A new thought.`)
  await box.press("ControlOrMeta+z")
  await expectTextBox(box, description)
  // Playwright's contenteditable fill exercises a full input/paste replacement with Unicode.
  const pasted = "日本語の港。\nEmoji: 👩🏽‍🚀\n\nA final line."
  await box.fill(pasted)
  await expect
    .poll(
      async () =>
        (await admin((api) => api.OpenEditor({ refId: id }))).drafts.find(
          (draft) => draft.key.field === textField(["description"])
        )?.content
    )
    .toBe(pasted)
  // An entry restores directly, with the latest revision's action kept disabled.
  await saveRevision(page)
  await page.getByRole("button", { name: "History", exact: true }).click()
  const history = page.getByRole("dialog", { name: "History", exact: true })
  const revisions = history.getByRole("list", { name: "Revisions" }).getByRole("listitem")
  await expect(revisions.first().getByRole("button", { name: /^Restore to revision / })).toBeDisabled()
  await expect(history.getByRole("tab")).toHaveCount(0)
  await revisions.nth(1).getByRole("button", { name: "Restore to revision 2", exact: true }).click()
  await history.getByRole("button", { name: "Close", exact: true }).click()
  await expectTextBox(box, description)
  await expect(page.locator(".rp-line-added, .rp-line-modified, .rp-line-deleted")).toHaveCount(0)
  await expect
    .poll(async () => {
      const draft = (await admin((api) => api.OpenEditor({ refId: id }))).drafts.find(
        (draft) => draft.key.field === textField(["description"]) && draft.status === "active"
      )
      return draft?.content ?? description
    })
    .toBe(description)
})

test("paste and IME composition reach the draft without truncation", async ({ page }) => {
  const id = await create()
  await open(page, id)
  const box = field(page, "Description")
  await box.fill("")
  await box.focus()
  const pasted = "A pasted line.\n\nAnother line with 👩🏽‍🚀."
  await box.evaluate((element, text) => {
    const clipboard = new DataTransfer()
    clipboard.setData("text/plain", text)
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true, composed: true })
    )
  }, pasted)
  await expectTextBox(box, pasted)
  await box.fill("")
  // Exercise native composition events and the DOM mutation/input sequence an IME uses.
  await box.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, composed: true }))
    const line = element.querySelector(".cm-line")!
    line.textContent = "日本語の港"
    const range = document.createRange()
    range.selectNodeContents(line)
    range.collapse(false)
    const selection = (element.getRootNode() as ShadowRoot & { getSelection: () => Selection }).getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    element.dispatchEvent(
      new InputEvent("input", {
        inputType: "insertCompositionText",
        data: "日本語の港",
        isComposing: true,
        bubbles: true,
        composed: true
      })
    )
  })
  await expectTextBox(box, "日本語の港")
  await box.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語の港", bubbles: true, composed: true }))
  )
  await expect
    .poll(
      async () =>
        (await admin((api) => api.OpenEditor({ refId: id }))).drafts.find(
          (draft) => draft.key.field === textField(["description"])
        )?.content
    )
    .toBe("日本語の港")
})

test("a draft typed on after another tab saved saves over that tab's revision", async ({ page, browser }) => {
  const id = await create()
  await open(page, id)
  await field(page, "Description").fill(newDescription)
  const context = await browser.newContext()
  try {
    const other = await context.newPage()
    await open(other, id, newDescription)
    // The shared server draft is already visible here; save a different head from it.
    await field(other, "Description").fill("A different saved head.")
    await saveRevision(other)
    await expectSaveState(other, NOTHING_TO_SAVE)
    await field(page, "Description").fill(`${newDescription}\nStill based on the original.`)
    await expect(
      field(page, "Description").locator("..").locator(".rp-line-added, .rp-line-modified").first()
    ).toBeVisible()
    // The first Save meets the stale editor (Save says it failed: the ref changed), which then
    // has the other tab's revision loaded; the next saves this tab's text, maybe after the picker.
    await saveButton(page).click()
    const stale = saveCluster(page).and(page.locator('[data-save-state="failed"]'))
    const conflict = page.getByRole("dialog", { name: "Changed meanwhile" })
    const done = saveCluster(page).and(page.locator('[data-save-state="clean"], [data-save-state="saved"]'))
    await expect(stale.or(conflict).or(done).first()).toBeVisible()
    if (await stale.isVisible()) {
      await saveButton(page).click()
      await expect(conflict.or(done).first()).toBeVisible()
    }
    if (await conflict.isVisible()) {
      // Each field starts on this tab's version.
      await conflict.getByRole("button", { name: "Use these and save", exact: true }).click()
    }
    await expect(saveButton(page)).toBeDisabled()
    const opened = await admin((api) => api.OpenEditor({ refId: id }))
    expect(opened.doc.description).toBe(`${newDescription}\nStill based on the original.`)
  } finally {
    await context.close()
  }
})

test("realistic synthetic folder walkthrough", async ({ page }) => {
  test.skip(!process.env.UNIT_B_SCREENS, "Set UNIT_B_SCREENS to capture the review walkthrough")
  test.setTimeout(180_000)
  const dir = resolve(process.env.UNIT_B_SCREENS!)
  mkdirSync(dir, { recursive: true })
  const st = writeRealisticStFolder(join(server().dataDir, "synthetic-st"))
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import/st`)
  await page.getByLabel("Folder path").fill(st)
  await page.getByRole("button", { name: "Look in this folder" }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toContainText("Cards:", { timeout: 120_000 })
  await page.goto(`${server().url}/library`)
  await page.getByRole("link", { name: "Edit Aria Vance", exact: true }).click()
  const box = field(page, "Description")
  await expect(box).toBeEditable()
  const before = await textBoxValue(box)
  await box.fill(`A new watch begins at the harbor.\n${before.replace("rain", "fog")}`)
  await field(page, "Scenario").fill("The storm has reached the outer harbor.\nThe crew must choose a route.")
  const shoot = async (name: string) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      // The desktop merge has one shared scrollbar; both complete documents remain reachable.
      if (width === 1440) {
        const merge = page.getByRole("dialog").locator(".cm-mergeView").first()
        await expect
          .poll(() =>
            merge.evaluate((element) => {
              element.scrollTop = element.scrollHeight
              const end = element.scrollTop
              element.scrollTop = 0
              return end
            })
          )
          .toBeGreaterThan(0)
      }
      await page.screenshot({ path: join(dir, `${name}-${width}.png`) })
    }
  }
  await box.focus()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await box.evaluate((element) => {
      element.parentElement!.scrollTop = 0
      const host = (element.getRootNode() as ShadowRoot).host
      window.scrollTo(0, 0)
      const main = document.querySelector("main#content")!
      main.scrollTop += host.getBoundingClientRect().top - main.getBoundingClientRect().top - 220
    })
    await expect(box.locator("..").locator(".rp-line-added, .rp-line-modified").first()).toBeVisible()
    await page.screenshot({ path: join(dir, `editor-markers-${width}.png`) })
  }
  // Save asks nothing: what it saved is in History's comparison, shot below (no save diff to shoot).
  await saveRevision(page)
  await page.getByRole("button", { name: "History", exact: true }).click()
  await page
    .getByRole("list", { name: "Revisions" })
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: /^Revision \d+ / })
    .click()
  await page.getByRole("dialog").getByText("Description", { exact: true }).click()
  await expect(page.getByRole("dialog").locator(".cm-editor").first()).toBeVisible()
  await shoot("revision-browser")
  await page.emulateMedia({ colorScheme: "dark" })
  await shoot("revision-browser-dark")
})
