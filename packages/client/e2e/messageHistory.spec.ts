import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import type { SendResult } from "@rp/shared/chatApi.ts"
import type { LcmSummary } from "@rp/shared/lcm.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { messageMenu } from "./support/message.ts"
import { openPanel } from "./support/panel.ts"
import { level1 } from "./support/summaries.ts"

const server = serverPerFile(withAdmin)
const screens = process.env.SCREENSHOT_DIR ?? join(tmpdir(), "rp-message-history-screens")
const oldText = "The lantern keeper waited beside the harbor. ".repeat(8)
const middleText = "The road led past the lighthouse. ".repeat(8)

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`message and summary history ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
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
        })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      const mine = page.getByRole("article", { name: "Your message" }).first()
      await expect(mine.getByLabel("Message text")).toHaveValue("Accidental overwrite.")
      await page.reload()
      await mine.getByRole("button", { name: "Earlier draft text" }).click()
      const history = page.getByRole("dialog", { name: "Earlier draft text", exact: true })
      await expect(history.getByRole("button", { name: "Restore draft text" })).toHaveCount(2)
      await mkdir(screens, { recursive: true })
      await page.screenshot({ animations: "disabled", path: `${screens}/message-draft-${width}-${theme}.png` })
      await history.getByRole("button", { name: "Restore draft text" }).last().click()
      await expect(mine.getByLabel("Message text")).toHaveValue(oldText)
      // Closing a portaled history must not bubble Escape into Cancel on the editor.
      await mine.getByRole("button", { name: "Earlier draft text" }).click()
      await page.keyboard.press("Escape")
      await expect(mine.getByLabel("Message text")).toHaveValue(oldText)
      await mine.getByRole("button", { name: "Save", exact: true }).click()
      await messageMenu(mine, "Saved amendment history")
      const saved = page.getByRole("dialog", { name: "Saved amendment history", exact: true })
      await expect(saved.getByRole("button", { name: "Restore saved text" })).toHaveCount(2)
      await page.screenshot({ animations: "disabled", path: `${screens}/saved-amendments-${width}-${theme}.png` })
      await saved.getByRole("button", { name: "Restore saved text" }).first().click()
      await expect(mine.locator(".markdown")).toHaveText("Saved second wording.")
      await page.reload()
      await expect(mine.locator(".markdown")).toHaveText("Saved second wording.")
      const panel = await openPanel(page, "Summaries")
      await panel.getByRole("button", { name: /Edit the summary/ }).click()
      const box = page.getByRole("textbox", { name: /Text of the summary/ })
      await expect(box).toHaveValue("Overwritten summary draft.")
      await panel.getByRole("button", { name: "Earlier draft text" }).click()
      await expect(history.getByRole("button", { name: "Restore draft text" })).toHaveCount(2)
      await page.screenshot({ animations: "disabled", path: `${screens}/summary-draft-${width}-${theme}.png` })
      await history.getByRole("button", { name: "Restore draft text" }).last().click()
      await expect(box).toHaveValue(oldText)
    })
  }
