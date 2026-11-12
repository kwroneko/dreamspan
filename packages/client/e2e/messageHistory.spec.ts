import { expectTextBox } from "./support/textbox.ts"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { LcmSummary } from "@rp/shared/lcm.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { editHistory, messageMenu } from "./support/message.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"
import { level1 } from "./support/summaries.ts"

const server = serverPerFile(withAdmin)
const screens = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-message-history-screens")
const oldText = "The lantern keeper waited beside the harbor. ".repeat(8)
const middleText = "The road led past the lighthouse. ".repeat(8)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a failed summary comparison read can be retried without closing the draft ${width} ${theme}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Summary comparison recovery" })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "A harbor."
          })
          if (sent._tag !== "Posted") throw new Error("queued fixture")
          return { chat, entry: sent.entry }
        })
      )
      const summary = await level1(server().dataDir, fixture.chat.id, [fixture.entry], "Original summary.")
      await admin((api) =>
        Effect.gen(function* () {
          const key = { forkId: fixture.chat.currentForkId!, summaryId: summary.id as LcmSummary["id"] }
          yield* api.SaveSummaryDraft({
            ...key,
            draftId: null,
            content: "Recovered summary draft.",
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: summary.revisionId as LcmSummary["revisionId"]
          })
          yield* api.EditSummary({ ...key, content: "Newer summary.", expectedRowVersion: 1, commitDraft: null })
        })
      )
      let failed = false
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          const request = typeof data === "string" ? (JSON.parse(data) as { tag?: string; id?: string }) : null
          if (!failed && request?.tag === "ListSummaryRevisions") {
            failed = true
            const error = { _tag: "ServerError", message: "Synthetic comparison read failure" }
            socket.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] }
              })
            )
          } else upstream.send(data)
        })
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      const panel = await openPanel(page, "Summaries")
      await panel.getByRole("button", { name: /Edit the summary/ }).click()
      await expect(panel.getByRole("alert")).toHaveText(
        "Something failed on the server. The details are in the server's log."
      )
      const box = panel.getByRole("textbox", { name: /Text of the summary/ })
      await expectTextBox(box, "Recovered summary draft.")
      await mkdir(screens, { recursive: true })
      await page.screenshot({ animations: "disabled", path: `${screens}/summary-read-retry-${width}-${theme}.png` })
      await panel.getByRole("button", { name: "Retry saved text" }).click()
      await expectTextBox(box, "Recovered summary draft.")
      await panel.getByText("Compare with saved text", { exact: true }).click()
      if (width > 639)
        await expectTextBox(panel.getByRole("textbox", { name: "Before", exact: true }), "Original summary.")
      else await expect(panel.locator(".cm-deletedChunk").first()).toContainText("Original summary.")
      await expect(panel.getByRole("alert")).toHaveCount(0)
      await page.screenshot({ animations: "disabled", path: `${screens}/summary-read-recovered-${width}-${theme}.png` })
      await box.fill("Continued after the retry.")
      await expect(panel.getByText("Draft kept. Save to use it.")).toBeVisible()
      await panel.getByRole("button", { name: "Save", exact: true }).click()
      await expect
        .poll(
          async () =>
            (
              await admin((api) =>
                api.GetSummary({ forkId: fixture.chat.currentForkId!, summaryId: summary.id as LcmSummary["id"] })
              )
            ).content
        )
        .toBe("Continued after the retry.")
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`message and summary history ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Harbor histories" })
          const sent: SendResult = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: oldText
          })
          if (sent._tag !== "Posted") throw new Error("queued fixture")
          const amended = yield* api.AmendVersion({
            versionId: sent.entry.version.id,
            content: "Saved second wording.",
            expectedRowVersion: 1
          })
          const target = { _tag: "Edit", versionId: amended.id } as const
          let draft = yield* api.SaveMessageDraft({
            target,
            draftId: null,
            content: oldText,
            expectedRowVersion: null,
            expectedSession: null
          })
          for (const content of [middleText, "Accidental overwrite."])
            draft = yield* api.SaveMessageDraft({
              target,
              draftId: draft.id,
              content,
              expectedRowVersion: draft.rowVersion,
              expectedSession: draft.session
            })
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
          return { chat, entry: path.entries[0]! }
        })
      )
      const summary = await level1(server().dataDir, fixture.chat.id, [fixture.entry], "Summary of the harbor.")
      await admin((api) =>
        Effect.gen(function* () {
          const key = { forkId: fixture.chat.currentForkId!, summaryId: summary.id as LcmSummary["id"] }
          let draft = yield* api.SaveSummaryDraft({
            ...key,
            draftId: null,
            content: oldText,
            expectedRowVersion: null,
            expectedSession: null,
            baseRevisionId: summary.revisionId as LcmSummary["revisionId"]
          })
          for (const content of [middleText, "Overwritten summary draft."])
            draft = yield* api.SaveSummaryDraft({
              ...key,
              draftId: draft.id,
              content,
              expectedRowVersion: draft.rowVersion,
              expectedSession: draft.session,
              baseRevisionId: summary.revisionId as LcmSummary["revisionId"]
            })
          // Another tab saved after this draft started: retain the draft's revision base.
          yield* api.EditSummary({
            ...key,
            content: "A later saved summary.",
            expectedRowVersion: 1,
            commitDraft: null
          })
        })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      const mine = page.getByRole("article", { name: "Your message" }).first()
      await expectTextBox(mine.getByLabel("Message text"), "Accidental overwrite.")
      await expect(mine.locator(".rp-line-modified")).toHaveCount(1)
      await editHistory(mine, "Compare with saved text…")
      const messageDiff = page.getByRole("dialog", { name: "Compare with saved text", exact: true })
      await expectTextBox(
        messageDiff.getByRole("textbox", { name: width > 639 ? "This edit" : "Changes", exact: true }),
        "Accidental overwrite."
      )
      await mkdir(screens, { recursive: true })
      await page.screenshot({ animations: "disabled", path: `${screens}/message-editor-${width}-${theme}.png` })
      await page.reload()
      await expect(messageDiff).toBeVisible()
      await messageDiff.getByRole("button", { name: "Close", exact: true }).click()
      await editHistory(mine, "Earlier draft text…")
      const history = page.getByRole("dialog", { name: "Earlier draft text", exact: true })
      // The earliest state is the text the edit was typed on (owner, 2026-11-02), after the typed ones.
      await expect(history.getByRole("button", { name: "Restore draft text" })).toHaveCount(3)
      await mkdir(screens, { recursive: true })
      await page.screenshot({ animations: "disabled", path: `${screens}/message-draft-${width}-${theme}.png` })
      await history.getByRole("button", { name: "Restore draft text" }).nth(1).click()
      await expectTextBox(mine.getByLabel("Message text"), oldText)
      // Closing a portaled history must not bubble Escape into Cancel on the editor.
      await editHistory(mine, "Earlier draft text…")
      await expect(history).toBeVisible()
      // Focus can still be on the trigger before the modal's focus effect runs. Send
      // Escape from there deterministically, rather than relying on machine timing.
      await page
        .locator("article")
        .first()
        .getByRole("button", { name: "History of this edit", includeHidden: true })
        .evaluate((trigger) => {
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
        })
      await expectTextBox(mine.getByLabel("Message text"), oldText)
      await expect(mine.getByRole("button", { name: "Save", exact: true })).toBeVisible()
      await expect(history).toBeHidden()
      await editHistory(mine, "Earlier draft text…")
      await expect(history).toBeVisible()
      await history.getByRole("button", { name: "Close", exact: true }).focus()
      await page.keyboard.press("Escape")
      await expectTextBox(mine.getByLabel("Message text"), oldText)
      await mine.getByRole("button", { name: "Save", exact: true }).click()
      await messageMenu(mine, "Saved amendment history")
      const saved = page.getByRole("dialog", { name: "Saved amendment history", exact: true })
      await expect(saved.getByRole("button", { name: "Restore saved text" })).toHaveCount(2)
      await expect(saved.locator(".cm-editor")).toHaveCount(0)
      // A reload reopens the amendments dialog; closing it clears the address.
      await page.reload()
      await expect(saved.getByRole("button", { name: "Restore saved text" })).toHaveCount(2)
      await saved.getByText("Compare with saved text", { exact: true }).first().click()
      await expectTextBox(
        saved.getByRole("textbox", { name: width > 639 ? "After" : "Changes", exact: true }).first(),
        oldText
      )
      await page.screenshot({ animations: "disabled", path: `${screens}/saved-amendments-${width}-${theme}.png` })
      await saved.getByRole("button", { name: "Restore saved text" }).first().click()
      await expect(mine.locator(".markdown")).toHaveText("Saved second wording.")
      await page.reload()
      await expect(mine.locator(".markdown")).toHaveText("Saved second wording.")
      const panel = await openPanel(page, "Summaries")
      await panel.getByRole("button", { name: /Edit the summary/ }).click()
      const box = page.getByRole("textbox", { name: /Text of the summary/ })
      await expectTextBox(box, "Overwritten summary draft.")
      await panel.getByRole("button", { name: "Earlier draft text" }).click()
      await expect(history.getByRole("button", { name: "Restore draft text" })).toHaveCount(3)
      await page.screenshot({ animations: "disabled", path: `${screens}/summary-draft-${width}-${theme}.png` })
      await history.getByRole("button", { name: "Restore draft text" }).nth(1).click()
      await expectTextBox(box, oldText)
      await panel.getByText("Compare with saved text", { exact: true }).click()
      await expectTextBox(panel.getByRole("textbox", { name: width > 639 ? "After" : "Changes", exact: true }), oldText)
      if (width > 639)
        await expectTextBox(panel.getByRole("textbox", { name: "Before", exact: true }), "Summary of the harbor.")
      else await expect(panel.locator(".cm-deletedChunk").first()).toContainText("Summary of the harbor.")
      await panel.getByText("Compare with saved text", { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ animations: "disabled", path: `${screens}/summary-editor-${width}-${theme}.png` })
      await panel.getByRole("button", { name: "Save", exact: true }).click()
      await panel.getByRole("button", { name: /^Actions for the summary/ }).click()
      await page.getByRole("menuitem", { name: /Revisions of the summary/ }).click()
      // The summary's editor closed (the tab's Summary settings keep an editor of their own, ftabs).
      await expect(panel.locator("[data-summary] .cm-editor")).toHaveCount(0)
      await panel.getByText("Compare revision 1 with the text in use", { exact: true }).click()
      await expectTextBox(panel.getByRole("textbox", { name: width > 639 ? "After" : "Changes", exact: true }), oldText)
      await page.screenshot({ animations: "disabled", path: `${screens}/summary-revisions-${width}-${theme}.png` })
    })
  }

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`saved history URL reopens with its message far off screen ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
      const fixture = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Long synthetic dialog history" })
          yield* api.SetLcmEnabled({ chatId: chat.id, enabled: false })
          const first = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Before the edit."
          })
          if (first._tag !== "Posted") throw new Error("queued fixture")
          yield* api.AmendVersion({
            versionId: first.entry.version.id,
            content: "After the edit.",
            expectedRowVersion: 1
          })
          let parent = first.entry.slotId
          for (let n = 0; n < 240; n++) {
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: parent,
              branch: false,
              content: `Later message ${n}. ` + "Rain on the harbor. ".repeat(12)
            })
            if (sent._tag !== "Posted") throw new Error("queued fixture")
            parent = sent.entry.slotId
          }
          return { chat, first: first.entry }
        })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const base = `${server().url}/chats/${fixture.chat.id}?fork=${fixture.chat.currentForkId}`
      await page.goto(base)
      await expect(page.locator("article[data-slot]").last()).toContainText("Later message 239")
      const original = page.locator(`article[data-slot="${fixture.first.slotId}"]`)
      await expect(original).toHaveCount(0)
      const destination = `${base}&messageDialog=message.amendments:${fixture.first.version.id}`
      await page.goto(destination)
      await page.reload()
      const dialog = page.getByRole("dialog", { name: "Saved amendment history", exact: true })
      await expect(dialog.getByRole("button", { name: "Restore saved text" })).toHaveCount(1)
      await expect(original).toHaveCount(0)
      await expectLayout(page, info, "offscreen-amendments", { scope: '[role="dialog"]' })
      await dialog.getByRole("button", { name: "Close", exact: true }).click()
      await expect.poll(() => new URL(page.url()).searchParams.has("messageDialog")).toBe(false)
      await page.goBack()
      await expect(dialog).toBeVisible()
      await page.goForward()
      await expect(dialog).toBeHidden()
    })
