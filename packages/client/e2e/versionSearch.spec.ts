// Finding and ordering a message's versions in the version picker (VersionPicker.tsx; audit
// item 007): fifty long versions, a text filter that marks the words and keeps the hidden
// section and the starred filter, the sort menu, and Compare still working, at 1440 and 390
// in light and dark, with the layout audit of the open picker.
import { expect, test, type Page } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const filler = "The tide turns and the waves keep coming over the old stones. ".repeat(340)
let chatId = ""

test.beforeAll(async () => {
  chatId = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      yield* api.SetDisplayPrefs({
        prefs: { chatDensity: process.env.STACK_DENSITY === "compact" ? "compact" : "comfortable" }
      })
      const chat = yield* api.CreateChat({ title: "Swipes" })
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: `Version 1. ${"[".repeat(20000)}`,
        reply: false
      })
      if (sent._tag !== "Posted") return yield* Effect.die("unexpected queue")
      const slotId = sent.entry.slotId
      let rowVersion = sent.entry.rowVersion
      for (let n = 2; n <= 50; n++) {
        // Version 12 is the shortest; 30 and 41 mention a zeppelin.
        const content =
          n === 2
            ? `Version 2. ${" ".repeat(20000)}`
            : n === 12
              ? "Version 12, short."
              : `Version ${n}. ${filler}${n === 30 || n === 41 ? " Then İ saw a zeppelin drift over the harbour. <img src=x onerror=alert(1)>" : ""}`
        const entry = yield* api.WriteVersion({ slotId, content, expectedRowVersion: rowVersion })
        rowVersion = entry.rowVersion
      }
      const list = yield* api.ListVersions({ slotId })
      yield* api.SetVersionFlags({ versionId: list[29]!.id, hidden: true })
      yield* api.SetVersionFlags({ versionId: list[40]!.id, starred: true })
      yield* api.SetVersionFlags({ versionId: list[4]!.id, starred: true })
      return chat.id
    })
  )
})

const rows = (page: Page, name: "Swipes" | "Hidden versions") =>
  page.getByRole("list", { name, exact: true }).getByRole("listitem")

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the picker finds and sorts fifty versions at ${width} in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/chats/${chatId}`)
      const message = page.getByRole("article").last()
      await message
        .getByRole("group", { name: "Swipes", exact: true })
        .getByRole("button", { name: /choose a swipe/ })
        .click()
      const picker = page.getByRole("dialog", { name: "Swipes of message #1", exact: true })
      await expect(rows(page, "Swipes")).toHaveCount(49)

      // The filter: one shown, one hidden, the word marked; the starred filter narrows it.
      const field = picker.getByRole("searchbox", { name: "Find in swipes", exact: true })
      await page.evaluate(() => {
        const durations: number[] = []
        const observer = new PerformanceObserver((list) => durations.push(...list.getEntries().map((e) => e.duration)))
        observer.observe({ entryTypes: ["longtask"] })
        Object.assign(window, { versionSearchTiming: { durations, observer } })
      })
      const latency: number[] = []
      // Measure input-to-paint with the full megabyte of swipes, rather than just arrange().
      for (const text of ["z", "ze", "zep", "zepp", "zeppe", "zeppelin", "", "waves", ""]) {
        const started = performance.now()
        await field.fill(text)
        await field.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
        latency.push(performance.now() - started)
      }
      await info.attach("typing-latency-ms", { body: JSON.stringify(latency), contentType: "application/json" })
      expect(Math.max(...latency)).toBeLessThan(500)
      const longTasks = await page.evaluate(() => {
        const timing = (
          window as unknown as { versionSearchTiming: { durations: number[]; observer: PerformanceObserver } }
        ).versionSearchTiming
        timing.observer.disconnect()
        return timing.durations
      })
      await info.attach("main-thread-long-tasks-ms", {
        body: JSON.stringify(longTasks),
        contentType: "application/json"
      })
      expect(Math.max(0, ...longTasks)).toBeLessThan(150)
      await field.fill("Zeppelin")
      await expect(rows(page, "Swipes")).toHaveCount(1)
      await expect(rows(page, "Swipes").first()).toContainText("#41")
      await expect(rows(page, "Swipes").first().locator("mark")).toHaveText("zeppelin")
      await expect(picker.getByText("Hidden 1: left out of the arrows")).toBeVisible()
      await picker.getByRole("button", { name: /^Starred 2/ }).click()
      await expect(rows(page, "Swipes")).toHaveCount(1)
      await expect(picker.getByText("Hidden 1: left out of the arrows")).toHaveCount(0)
      await field.fill("nothing like this")
      await expect(picker.getByText("No starred swipe has “nothing like this”.")).toBeVisible()
      await picker.getByRole("button", { name: /^All 50/ }).click()
      await expect(picker.getByText("No swipe has “nothing like this”.")).toBeVisible()
      await field.fill("")
      await expect(rows(page, "Swipes")).toHaveCount(49)

      // The sort: explained on hover; shortest first puts version 12 at the top.
      const sort = picker.getByRole("button", { name: "Sort swipes: Order written", exact: true })
      await sort.hover()
      await expect(page.getByText("Chooses how swipes are ordered.").filter({ visible: true })).toBeVisible()
      await sort.click()
      await page.getByRole("menuitemcheckbox", { name: "Shortest first" }).click()
      await expect(picker).toBeVisible()
      await expect(rows(page, "Swipes").first()).toContainText("#12")
      await picker.getByRole("button", { name: "Sort swipes: Shortest first", exact: true }).click()
      await page.getByRole("menuitemcheckbox", { name: "Starred first" }).click()
      await expect(rows(page, "Swipes").nth(0)).toContainText("#5")
      await expect(rows(page, "Swipes").nth(1)).toContainText("#41")
      await picker.getByRole("button", { name: "Sort swipes: Starred first", exact: true }).click()
      await page.getByRole("menuitemcheckbox", { name: "Newest first" }).click()
      await expect(rows(page, "Swipes").first()).toContainText("#50")
      await field.fill("version")
      await expectLayout(page, info, `version-search-${width}-${theme}`, { scope: '[role="dialog"]' })
      await page.screenshot({ path: info.outputPath(`picker-${width}-${theme}.png`) })

      await field.fill("<img")
      await expect(rows(page, "Swipes")).toHaveCount(1)
      await expect(rows(page, "Swipes").locator("mark")).toHaveText("<img")
      await expect(rows(page, "Swipes").locator("img")).toHaveCount(0)
      await field.fill("version")

      // Compare still works on the sorted, filtered list.
      await picker.getByRole("button", { name: "Compare", exact: true }).click()
      await picker.getByRole("checkbox", { name: "Compare swipe 50", exact: true }).click()
      await picker.getByRole("checkbox", { name: "Compare swipe 49", exact: true }).click()
      await expect(page.getByRole("dialog", { name: "Swipe 49 and swipe 50", exact: true })).toBeVisible()
      await page.keyboard.press("Escape")

      // Reopened, the picker keeps the filter and sort; picking a version shows it.
      await message
        .getByRole("group", { name: "Swipes", exact: true })
        .getByRole("button", { name: /choose a swipe/ })
        .click()
      await expect(picker.getByRole("searchbox", { name: "Find in swipes" })).toHaveValue("version")
      await expect(picker.getByRole("button", { name: "Sort swipes: Newest first", exact: true })).toBeVisible()
      await picker.getByRole("button", { name: /^Swipe 12,/ }).click()
      await expect(picker).toHaveCount(0)
      await expect(message).toContainText("Version 12, short.")
      // Keyboard activation selects the version identified by the filtered/sorted row, too.
      await message.getByRole("button", { name: /choose a swipe/ }).click()
      await field.fill("Version 41.")
      const selected = picker.getByRole("button", { name: /^Swipe 41,/ })
      await selected.focus()
      await page.keyboard.press("Enter")
      await expect(picker).toHaveCount(0)
      await expect(
        message.getByRole("group", { name: "Swipes", exact: true }).getByRole("button", { name: /^Swipe 41 of 50/ })
      ).toBeVisible()
      // A reload mounts a new picker with its initial search and ordering.
      await page.reload()
      await message.getByRole("button", { name: /choose a swipe/ }).click()
      await expect(field).toHaveValue("")
      await expect(picker.getByRole("button", { name: "Sort swipes: Order written", exact: true })).toBeVisible()
    })
