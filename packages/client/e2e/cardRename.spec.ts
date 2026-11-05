// Synthetic cards and chats only. Exercise the UI's connection to the existing
// fork-aware rename backend: the name header asks on confirm (owner, 2026-11-01), and a
// replacement that failed outlives a reload.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { openPanel } from "./support/panel.ts"
import { chatNameLine, renameCard } from "./support/cardEditor.ts"
import { NOTHING_TO_SAVE, saveButton, saveCluster } from "./support/saveRevision.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let adminCookie: string
test.beforeAll(async () => {
  adminCookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), adminCookie, use)
/** Renames the nickname (nickname) in the header; a change asks about past messages at once. */
const rename = (page: Page, name: string) => renameCard(page, "nickname", name)
/** Closes the question, past the focused answer's explanation. */
const closePrompt = async (page: Page) =>
  expect(async () => {
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: /Replace the name|History replacement/ })).toHaveCount(0, {
      timeout: 500
    })
  }).toPass()
const prompt = (page: Page) => page.getByRole("dialog", { name: "Replace the name in past messages?", exact: true })
const seed = (label: string) =>
  admin((api) =>
    Effect.gen(function* () {
      const card = yield* api.CreateCard({ label, name: label, nickname: "Aria" })
      const chats = []
      for (const title of ["The lantern garden", "The observatory"]) {
        const chat = yield* api.CreateChat({ title })
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
        const sent = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: null,
          branch: false,
          content: "Aria lights the lantern."
        })
        if (sent._tag !== "Posted") throw new Error("queued")
        chats.push({ chat, slot: sent.entry.slotId })
      }
      const first = chats[0]!
      const sibling = yield* api.CreateFork({
        chatId: first.chat.id,
        fromForkId: first.chat.currentForkId,
        atSlotId: first.slot
      })
      yield* api.NameFork({ forkId: sibling.fork.id, name: "Garden sibling" })
      return { card, first, other: chats[1]!, sibling: sibling.fork }
    })
  )
type Seed = Awaited<ReturnType<typeof seed>>
const texts = (f: Seed) =>
  admin((api) =>
    Effect.gen(function* () {
      const results = []
      for (const target of [
        { chatId: f.first.chat.id, forkId: f.first.chat.currentForkId!, leafSlotId: f.first.slot },
        { chatId: f.first.chat.id, forkId: f.sibling.id, leafSlotId: f.first.slot },
        { chatId: f.other.chat.id, forkId: f.other.chat.currentForkId!, leafSlotId: f.other.slot }
      ]) {
        const path = yield* api.ReadPath({ ...target, range: { _tag: "Bottom" }, limit: 10 })
        results.push(path.entries[0]!.version.content)
      }
      return results
    })
  )
const shot = async (page: Page, name: string) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  expect(await page.getByRole("dialog").evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth)).toBe(0)
  if (process.env.SCREENSHOT_DIR) {
    mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, name + ".png"), animations: "disabled" })
  }
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`card rename scopes and diff/undo ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const f = await seed(`Library Aria ${width} ${theme}`)
      await page.goto(`${server().url}/library/${f.card.id}`)
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
      // A display name change leaves the name chats use unchanged: nothing is asked.
      await renameCard(page, "display", `Display Aria ${width} ${theme}`)
      await expect(page.getByRole("heading", { level: 1, name: `Display Aria ${width} ${theme}` })).toBeVisible()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(chatNameLine(page, "Aria")).toBeVisible()
      await rename(page, "Ari")
      await expect(
        prompt(page).getByRole("button", { name: "Yes, in all 3 chats with Aria", exact: true })
      ).toBeEnabled()
      await shot(page, `rename-choices-${width}-${theme}`)
      await prompt(page).getByRole("button", { name: "No. Past messages will keep “Aria”.", exact: true }).click()
      // The names are live text; saving makes them the card's revision, which the Cast lists by.
      await saveButton(page).click()
      await expect(saveCluster(page).first()).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)
      expect(await texts(f)).toEqual(Array(3).fill("Aria lights the lantern."))
      // An editor opened from a chat carries exactly that fork, even when another is current.
      await page.goto(`${server().url}/chats/${f.first.chat.id}?fork=${f.first.chat.currentForkId}`)
      await openPanel(page, "Cast")
      // Over the chat, which it names to the save; from the row's ⋯.
      await page.getByRole("button", { name: `More for Display Aria ${width} ${theme}`, exact: true }).click()
      await page
        .getByRole("menuitem", { name: `Open Display Aria ${width} ${theme} in the full editor`, exact: true })
        .click()
      await expect(page.getByRole("region", { name: "Card editor", exact: true })).toBeVisible()
      await rename(page, "Aria")
      await prompt(page).getByRole("button", { name: /^No\./ }).click()
      await rename(page, "Ari")
      await expect(prompt(page).getByRole("status").filter({ hasText: "Only this chat refers to:" })).toContainText(
        "The lantern garden"
      )
      await shot(page, `rename-chat-target-${width}-${theme}`)
      await prompt(page).getByRole("button", { name: "Yes, only in this chat.", exact: true }).click()
      await expect(page.getByRole("list", { name: "History diffs and undo" })).toBeVisible()
      expect(await texts(f)).toEqual([
        "Ari lights the lantern.",
        "Aria lights the lantern.",
        "Aria lights the lantern."
      ])
      await shot(page, `rename-result-${width}-${theme}`)
      await page.getByRole("link", { name: /^History diff \/ undo:/ }).click()
      await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Undo all", exact: true }).click()
      await expect(page.getByRole("button", { name: "Undo all", exact: true })).toBeDisabled()
      expect(await texts(f)).toEqual(Array(3).fill("Aria lights the lantern."))
      // Clearing nickname falls back to the display name; all includes the sibling fork.
      await page.goto(`${server().url}/library/${f.card.id}`)
      await rename(page, "")
      await expect(prompt(page)).toContainText(`call them “Display Aria ${width} ${theme}” instead of “Ari”`)
      await prompt(page).getByRole("button", { name: /^No\./ }).click()
      // Use a separate card to exercise a successful all-chats rename from its old model name.
      const all = await seed(`All scope ${width} ${theme}`)
      await page.goto(`${server().url}/library/${all.card.id}`)
      await rename(page, "Ari")
      await prompt(page).getByRole("button", { name: "Yes, in all 3 chats with Aria", exact: true }).click()
      await expect(page.getByRole("status").filter({ hasText: "in 3 chats" })).toBeVisible()
      expect(await texts(all)).toEqual(Array(3).fill("Ari lights the lantern."))
      await expect(page.getByRole("list", { name: "History diffs and undo" }).getByRole("link")).toHaveCount(3)
    })
  }

test("a failed history action survives reload without saving the card twice", async ({ page }) => {
  const f = await seed("Recoverable rename")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  let fail = true
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = JSON.parse(String(data))
      if (request.tag === "RenameHistory" && fail) {
        // A real NotFound reply, as if the card had been deleted in another tab.
        request.payload.entityId = "synthetic-missing-card"
        upstream.send(JSON.stringify(request))
      } else upstream.send(data)
    })
  })
  await page.goto(`${server().url}/library/${f.card.id}`)
  await rename(page, "Ari")
  await prompt(page).getByRole("button", { name: "Yes, in all 3 chats with Aria", exact: true }).click()
  await expect(prompt(page).getByRole("alert")).toBeVisible()
  // Closed after the failure, the rename still goes ahead; the replacement can be resumed.
  await closePrompt(page)
  await expect(chatNameLine(page, "Ari")).toBeVisible()
  expect(await texts(f)).toEqual(Array(3).fill("Aria lights the lantern."))
  const revision = (await admin((api) => api.OpenEditor({ refId: f.card.id }))).ref.headRevisionId
  await page.reload()
  await page.getByRole("button", { name: "Resume history replacement", exact: true }).click()
  fail = false
  await prompt(page).getByRole("button", { name: "Yes, in all 3 chats with Aria", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "in 3 chats" })).toBeVisible()
  expect(await texts(f)).toEqual(Array(3).fill("Ari lights the lantern."))
  expect((await admin((api) => api.OpenEditor({ refId: f.card.id }))).ref.headRevisionId).toBe(revision)
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("button", { name: "Resume history replacement", exact: true })).toHaveCount(0)
})

test("forking a card for this chat replaces history only in the viewed fork", async ({ page }) => {
  const f = await seed("Forked Aria")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${f.first.chat.id}?fork=${f.first.chat.currentForkId}&panel=cast`)
  await page.getByRole("button", { name: "More for Forked Aria", exact: true }).click()
  await page.getByRole("menuitem", { name: "Fork for this chat: Forked Aria", exact: true }).click()
  const fork = page.getByRole("dialog", { name: "Fork for this chat", exact: true })
  await fork.getByRole("textbox", { name: "Version (shown as subtitle)", exact: true }).fill("Renamed")
  await fork.getByRole("textbox", { name: "In-character name", exact: true }).fill("Ari")
  await fork.getByRole("button", { name: "Fork and edit", exact: true }).click()
  await expect(prompt(page)).toContainText("from “Aria” to “Ari”")
  await expect(prompt(page).getByRole("button", { name: /^Yes, in all/ })).toHaveCount(0)
  await prompt(page).getByRole("button", { name: "Yes, only in this chat.", exact: true }).click()
  await expect(page.getByRole("list", { name: "History diffs and undo" })).toBeVisible()
  expect(await texts(f)).toEqual(["Ari lights the lantern.", "Aria lights the lantern.", "Aria lights the lantern."])
  await page.getByRole("link", { name: /^History diff \/ undo:/ }).click()
  await expect(page.getByRole("dialog", { name: "History replacement finished" })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Undo all", exact: true }).click()
  await expect(page.getByRole("button", { name: "Undo all", exact: true })).toBeDisabled()
  expect(await texts(f)).toEqual(Array(3).fill("Aria lights the lantern."))
})

test("closing the question cancels the rename and leaves nothing to resume", async ({ page }) => {
  const f = await seed("Repeated rename")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${f.card.id}`)
  for (const name of ["Ari", "Ada"]) {
    await rename(page, name)
    await expect(prompt(page)).toBeVisible()
    await closePrompt(page)
    await expect(page.getByRole("textbox", { name: "In-chat nickname", exact: true })).toHaveValue(name)
    await page.getByRole("button", { name: "Cancel renaming", exact: true }).click()
    await expect(chatNameLine(page, "Aria")).toBeVisible()
  }
  await page.reload()
  await expect(chatNameLine(page, "Aria")).toBeVisible()
  await expect(page.getByRole("button", { name: "Resume history replacement", exact: true })).toHaveCount(0)
  expect(await texts(f)).toEqual(Array(3).fill("Aria lights the lantern."))
})

test("a library rename can target a chosen fork instead of the current one", async ({ page }) => {
  const f = await seed("Library fork choice")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library/${f.card.id}`)
  await rename(page, "Ari")
  await prompt(page).getByRole("combobox", { name: "Chat for only this chat" }).click()
  await page.getByRole("option", { name: /^The lantern garden · Garden sibling/ }).click()
  await prompt(page).getByRole("button", { name: "Yes, only in this chat.", exact: true }).click()
  await expect(page.getByRole("list", { name: "History diffs and undo" })).toBeVisible()
  expect(await texts(f)).toEqual(["Aria lights the lantern.", "Ari lights the lantern.", "Aria lights the lantern."])
})

test("a recovered chat offer names its original target when opened from another chat", async ({ page }) => {
  const f = await seed("Recovery target")
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  // The replacement fails once, so it's kept for Resume.
  let fail = true
  await page.routeWebSocket("**/rpc", (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const request = JSON.parse(String(data))
      if (request.tag === "RenameHistory" && fail) {
        request.payload.entityId = "synthetic-missing-card"
        upstream.send(JSON.stringify(request))
      } else upstream.send(data)
    })
  })
  await page.goto(`${server().url}/chats/${f.first.chat.id}?fork=${f.sibling.id}&panel=cast`)
  await page.getByRole("button", { name: "More for Recovery target", exact: true }).click()
  await page.getByRole("menuitem", { name: "Open Recovery target in the full editor", exact: true }).click()
  await rename(page, "Ari")
  await prompt(page).getByRole("button", { name: "Yes, only in this chat.", exact: true }).click()
  await expect(prompt(page).getByRole("alert")).toBeVisible()
  await closePrompt(page)
  fail = false
  await page.goto(`${server().url}/chats/${f.other.chat.id}?panel=cast`)
  await page.getByRole("button", { name: "More for Recovery target", exact: true }).click()
  await page.getByRole("menuitem", { name: "Resume history replacement", exact: true }).click()
  await expect(prompt(page).getByRole("status").filter({ hasText: "Only this chat refers to:" })).toContainText(
    "The lantern garden · Garden sibling"
  )
  await prompt(page).getByRole("button", { name: "Yes, only in this chat.", exact: true }).click()
  await expect(page.getByRole("list", { name: "History diffs and undo" })).toBeVisible()
  expect(await texts(f)).toEqual(["Aria lights the lantern.", "Ari lights the lantern.", "Aria lights the lantern."])
})

test("using a renamed family member can replace history only in the viewed fork", async ({ page }) => {
  const f = await seed("Family source")
  await admin((api) =>
    api.ForkCard({
      refId: f.card.id,
      name: "Family replacement",
      nickname: "Ari",
      characterVersion: ""
    })
  )
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats/${f.first.chat.id}?fork=${f.first.chat.currentForkId}&panel=cast`)
  await page.getByRole("button", { name: "More for Family source", exact: true }).click()
  await page.getByRole("menuitem", { name: "Use another version: Family source", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Use another version", exact: true })
    .getByRole("button", { name: /Family replacement/ })
    .click()
  await expect(prompt(page)).toContainText("from “Aria” to “Ari”")
  await expect(prompt(page).getByRole("button", { name: /^Yes, in all/ })).toHaveCount(0)
  await prompt(page).getByRole("button", { name: "Yes, only in this chat.", exact: true }).click()
  await expect(page.getByRole("list", { name: "History diffs and undo" })).toBeVisible()
  expect(await texts(f)).toEqual(["Ari lights the lantern.", "Aria lights the lantern.", "Aria lights the lantern."])
})
