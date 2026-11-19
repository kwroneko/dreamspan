// QA walkthrough regressions. All cards, portraits and history here are synthetic.
import { panelTab } from "./support/panel.ts"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { closePortrait, portraitPng } from "./support/portrait.ts"
import { condensed, level1 } from "./support/summaries.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
const shoot = async (page: Page, name: string) => {
  if (!process.env.REVIEW_SCREENSHOTS) return
  await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true })
  await page.screenshot({ path: join(process.env.REVIEW_SCREENSHOTS, `${name}.png`), fullPage: true })
}

test.beforeEach(async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
})

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`departed speakers retain names and portraits after persona switches at ${width} ${theme}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const refs = await admin((api) =>
        Effect.gen(function* () {
          const sam = yield* api.CreateCard({ label: "Sam", name: "Sam" })
          const kim = yield* api.CreateCard({ label: `Kim ${width} ${theme}`, name: `Kim ${width} ${theme}` })
          const rhee = yield* api.CreateCard({ label: "Captain Rhee", name: "Captain Rhee" })
          for (const card of [sam, kim]) yield* api.SetPersona({ entityId: card.entityId, persona: true })
          return { sam, kim, rhee }
        })
      )
      for (const ref of [refs.sam, refs.rhee]) {
        const response = await page.request.post(
          `${server().url}/library/avatar?ref=${ref.id}&rowVersion=${ref.rowVersion}`,
          { headers: { origin: server().url, "content-type": "application/octet-stream" }, data: portraitPng() }
        )
        expect(response.ok()).toBeTruthy()
      }
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Historical speakers" })
          for (const card of [refs.sam, refs.rhee])
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          yield* api.ChangeCast({
            chatId: chat.id,
            slotId: null,
            change: { _tag: "PlayedByMe", entityIds: [refs.sam.entityId] }
          })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Sam remembers the harbor.",
            speakerEntityId: refs.sam.entityId
          })
          if (sent._tag !== "Posted") throw new Error("queued")
          const generated = yield* api.Generate({
            chatId: chat.id,
            parentSlotId: sent.entry.slotId,
            branch: false,
            speakerEntityId: refs.sam.entityId
          })
          if (generated._tag !== "Posted") throw new Error("queued")
          return { chat, sent: sent.entry, generated: generated.entry }
        })
      )
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      const impersonated = page.locator(`article[data-slot="${fixture.generated.slotId}"]`)
      await expect(impersonated).toBeVisible()
      await expect(impersonated.getByText("generating", { exact: true })).toHaveCount(0)
      await expect(impersonated.locator("header")).toContainText("Sam")
      const written = await admin((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: fixture.chat.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 10
          })
          const current = path.entries.find((entry) => entry.slotId === fixture.generated.slotId)!
          yield* api.WriteVersion({
            slotId: current.slotId,
            expectedRowVersion: current.rowVersion,
            content: "Sam's hand-written impersonation version."
          })
          const departed = yield* api.SendMessage({
            chatId: fixture.chat.id,
            parentSlotId: current.slotId,
            branch: false,
            content: "Rhee leaves the harbor.",
            speakerEntityId: refs.rhee.entityId
          })
          if (departed._tag !== "Posted") throw new Error("queued")
          yield* api.ChangeCast({
            chatId: fixture.chat.id,
            slotId: departed.entry.slotId,
            change: { _tag: "Leave", entityId: refs.rhee.entityId }
          })
          return departed.entry
        })
      )
      // Switch through the real persona control, then reload to rule out an in-memory face cache.
      await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=cast`)
      await page
        .getByRole("group", { name: "Your persona", exact: true })
        .getByRole("button", { name: /^Playing as / })
        .click()
      await page.getByRole("option", { name: `Kim ${width} ${theme}`, exact: true }).click()
      await page.reload()
      await page.getByRole("button", { name: width === 390 ? "Close" : "Hide panel", exact: true }).click()
      for (const [slot, name] of [
        [fixture.sent.slotId, "Sam"],
        [fixture.generated.slotId, "Sam"],
        [written.slotId, "Captain Rhee"]
      ]) {
        const row = page.locator(`article[data-slot="${slot}"]`)
        await expect(row.locator("header")).toContainText(name!)
        await expect(
          row.getByRole("button", { name: `View ${name}'s portrait`, exact: true }).locator("img")
        ).toBeVisible()
      }
      await expect(impersonated).toContainText("Sam's hand-written impersonation version.")
      await shoot(page, `historical-speakers-${width}-${theme}`)
      await impersonated.getByRole("button", { name: "View Sam's portrait", exact: true }).click()
      await expect(page.getByRole("img", { name: "Sam's full portrait", exact: true })).toBeVisible()
      await closePortrait(page)
      await admin((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: fixture.chat.id,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 10
          })
          const entry = path.entries.find((entry) => entry.slotId === fixture.generated.slotId)!
          yield* api.SelectVersion({
            slotId: entry.slotId,
            versionId: fixture.generated.version.id,
            expectedVersionId: entry.version.id
          })
        })
      )
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      await expect(impersonated.locator("header")).toContainText("Sam")
      await expect(impersonated).not.toContainText("Sam's hand-written impersonation version.")
      await expect(
        impersonated.getByRole("button", { name: "View Sam's portrait", exact: true }).locator("img")
      ).toBeVisible()
    })

    test(`summary search results open their summary at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Summary search" })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "A harbor story."
          })
          if (sent._tag !== "Posted") throw new Error("queued")
          return { chat, entry: sent.entry }
        })
      )
      const summary = await level1(
        server().dataDir,
        fixture.chat.id,
        [fixture.entry],
        "The bridge crosses the harbor. Another bridge."
      )
      await condensed(server().dataDir, fixture.chat.id, [summary], "The higher-level overview of the harbor.")
      await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=history`)
      await page.getByRole("textbox", { name: "Find", exact: true }).fill("bridge")
      await page.getByRole("textbox", { name: "Replace with", exact: true }).fill("pier")
      const result = page.getByRole("button", { name: "Level 1 summary, messages 1–1", exact: true })
      await expect(result).toBeVisible()
      await expect(page.getByRole("button", { name: "Replace all", exact: true })).toBeEnabled()
      await page.getByLabel("Skip match 1 in message 1", { exact: true }).check()
      await result.click()
      await expect(page.getByRole("tab", { name: "Summaries", exact: true })).toHaveAttribute("aria-selected", "true")
      const row = page.locator(`[data-summary="${summary.id}"]`)
      await expect(row).toBeVisible()
      await expect(row).toContainText("The bridge crosses the harbor.")
      await expect(row).toHaveClass(/ring-accent/)
      const preview = row.getByLabel("Replacement preview", { exact: true })
      await expect(preview.locator("del")).toHaveText("bridge")
      await expect(preview.locator("ins")).toHaveText("pier")
      await shoot(page, `summary-search-${width}-${theme}`)
      // Returning preserves the query; match navigation must open summaries too.
      await panelTab(page, "History edits")
      await expect(page.getByRole("textbox", { name: "Find", exact: true })).toHaveValue("bridge")
      await expect(page.getByLabel("Skip match 1 in message 1", { exact: true })).toBeChecked()
      await page.getByRole("button", { name: "Next", exact: true }).click()
      await expect(row).toBeVisible()
      await expect(preview.locator("del")).toHaveText("bridge")
      await panelTab(page, "History edits")
      await page.getByRole("button", { name: "Previous", exact: true }).click()
      await expect(row).toBeVisible()
      await expect(preview.locator("ins")).toHaveText("pier")
      // Closing the workspace discards previews; reopening Summaries must not resurrect them.
      await page.getByRole("button", { name: width === 390 ? "Close" : "Hide panel", exact: true }).click()
      await page.goto(`${server().url}/chats/${fixture.chat.id}?panel=summaries`)
      await expect(page.getByLabel("Replacement preview", { exact: true })).toHaveCount(0)
    })

    test(`group header gives the full name room at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const title = "Masquerade at Corvina Hall"
      const chat = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title })
          for (const name of ["Aria", "Rook", "Ione", "Bram", "Vela"]) {
            const card = yield* api.CreateCard({ label: name, name })
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
          }
          return chat
        })
      )
      await page.goto(`${server().url}/chats/${chat.id}`)
      const heading = page.getByRole("heading", { level: 1, name: title, exact: true })
      await expect(heading).toBeVisible()
      // The title can appear before the branch control finishes loading. Check
      // the final header rather than that transient extra space.
      const branch = page.getByRole("button", { name: /^Branch: Original, 1 of 1:/ })
      await expect(branch).toBeDisabled()
      // A clamped title still has the full accessible name, so inspect its actual text box.
      const label = heading.locator("span").first()
      const whole = (node: Element) => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth
      if (width === 390) {
        // At phone width the chat's name gives up room before a short branch name does
        // (branchlabel1, 2026-11-17): "Original" shows in full, and the name keeps its 6rem.
        await expect.poll(() => branch.locator("span").last().evaluate(whole)).toBeTruthy()
        await expect.poll(async () => (await label.boundingBox())!.width).toBeGreaterThanOrEqual(96)
      } else await expect.poll(() => label.evaluate(whole)).toBeTruthy()
      // Since the one-row header (4c46cbd5) the name's box is as wide as its text, not the room
      // around it, so the check above (nothing cut off) is what "the full name has room" means.
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
      await shoot(page, `group-title-${width}-${theme}`)
    })
  }
