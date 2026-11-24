import { expect, test } from "@playwright/test"
import { Effect, Schema } from "effect"
import { SummaryId } from "@dreamspan/shared/lcm.ts"
import { level1 } from "./support/summaries.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

test("a replacement in one search box clears only match skips on changed revisions", async ({ page }) => {
  const [name, ...value] = cookie.split("=")
  await page.context().addCookies([{ name: name!, value: value.join("="), url: server().url }])
  const { chat, leaf } = await withCookie(server(), cookie, (api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "Match skips" })
      const first = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        branch: false,
        content: "cat cat cat"
      })
      if (first._tag !== "Posted") throw new Error("queued")
      const second = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: first.entry.slotId,
        branch: false,
        content: "cat stays"
      })
      if (second._tag !== "Posted") throw new Error("queued")
      return { chat, leaf: second.entry.slotId }
    })
  )
  await page.goto(`${server().url}/chats/${chat.id}?panel=history`)
  const panel = page.locator("[data-history-panel]")
  const first = panel.getByRole("region", { name: "Search and replace 1", exact: true })
  await first.getByRole("textbox", { name: "Find", exact: true }).fill("cat")
  await first.getByRole("textbox", { name: "Replace with", exact: true }).fill("dog")
  const changed = first.getByLabel("Skip match 2 in message 1", { exact: true })
  const unchanged = first.getByLabel("Skip match 1 in message 2", { exact: true })
  await changed.check()
  await unchanged.check()

  await panel.getByRole("button", { name: "Add search and replace", exact: true }).click()
  const second = panel.getByRole("region", { name: "Search and replace 2", exact: true })
  await second.getByRole("textbox", { name: "Find", exact: true }).fill("cat")
  await second.getByRole("textbox", { name: "Replace with", exact: true }).fill("bird")
  await second.getByRole("button", { name: "Replace", exact: true }).click()
  await expect(first.getByRole("status")).toContainText("3 in messages")
  await expect(changed).not.toBeChecked()
  await expect(unchanged).toBeChecked()
  await expect(first.getByRole("status")).toContainText("1 match skip cleared")
  await first.getByRole("button", { name: "Replace all", exact: true }).click()
  await expect(first.getByRole("status")).toContainText("1 in messages")
  const path = await withCookie(server(), cookie, (api) =>
    api.ReadPath({ chatId: chat.id, leafSlotId: leaf, range: { _tag: "Bottom" }, limit: 10 })
  )
  expect(path.entries.map((entry) => entry.version.content)).toEqual(["bird dog dog", "cat stays"])
})

for (const width of [390, 1024, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`independent search boxes reveal, remove and replace each scope at ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const [name, ...value] = cookie.split("=")
      await page.context().addCookies([{ name: name!, value: value.join("="), url: server().url }])
      const { chat, entry } = await withCookie(server(), cookie, (api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "Search box scopes" })
          const sent = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            branch: false,
            content: "Aria's other version."
          })
          if (sent._tag !== "Posted") throw new Error("queued")
          const entry = yield* api.WriteVersion({
            slotId: sent.entry.slotId,
            expectedRowVersion: sent.entry.rowVersion,
            content: "Aria's selected message."
          })
          return { chat, entry }
        })
      )
      const summary = await level1(server().dataDir, chat.id, [entry], "Aria's summary.")
      const held: Array<() => void> = []
      let holding = true
      await page.routeWebSocket(/\/rpc$/, (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => {
          if (holding && typeof data === "string" && JSON.parse(data).tag === "ApplyHistoryEdits")
            held.push(() => upstream.send(data))
          else upstream.send(data)
        })
      })
      await page.goto(`${server().url}/chats/${chat.id}?panel=history`)
      const panel = page.locator("[data-history-panel]")
      const boxes = panel.getByRole("region", { name: /^Search and replace \d+$/ })
      const add = panel.getByRole("button", { name: "Add search and replace", exact: true })
      await expect(panel.getByText("No edits applied yet.", { exact: true })).toBeVisible()

      // The responsive panel may remount as the chat's initial state arrives. Measure
      // both fields in one browser read and retry until their visible layout is ready.
      await expect
        .poll(() =>
          boxes
            .first()
            .getByRole("textbox")
            .evaluateAll((fields) => {
              if (fields.length !== 2) return false
              const [find, replace] = fields.map((field) => field.getBoundingClientRect())
              return find!.width > 0 && replace!.width > 0 && Math.abs(find!.width - replace!.width) < 1
            })
        )
        .toBe(true)
      await expect
        .poll(() =>
          boxes
            .first()
            .getByRole("group", { name: "Look in", exact: true })
            .getByRole("button")
            .evaluateAll(
              (buttons) =>
                buttons.length === 3 &&
                buttons.every((button, index) => {
                  if (!index) return true
                  const previous = buttons[index - 1]!.getBoundingClientRect()
                  const current = button.getBoundingClientRect()
                  return current.top === previous.top && current.left - previous.right >= 4
                })
            )
        )
        .toBe(true)

      await expect(panel.getByRole("button", { name: "Remove this search and replace" })).toHaveCount(0)
      await boxes.first().getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
      await boxes.first().getByRole("textbox", { name: "Replace with", exact: true }).fill("Message")
      for (let index = 1; index < 4; index++) {
        await add.click()
        await expect(boxes).toHaveCount(index + 1)
        const box = boxes.nth(index)
        await expect(box).toHaveAttribute("data-flashing", "")
        await expect
          .poll(() =>
            box.evaluate((element) => {
              const rect = element.getBoundingClientRect()
              let top = 0,
                bottom = innerHeight
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
                  const bounds = parent.getBoundingClientRect()
                  top = Math.max(top, bounds.top)
                  bottom = Math.min(bottom, bounds.bottom)
                }
              }
              return rect.top >= top && rect.bottom <= bottom
            })
          )
          .toBe(true)
      }
      // Removing a middle box keeps the remaining boxes' own text and options.
      await boxes.nth(1).getByRole("textbox", { name: "Find", exact: true }).fill("remove me")
      await boxes.nth(1).getByRole("button", { name: "Remove this search and replace" }).click()
      await expect(boxes).toHaveCount(3)
      await expect(boxes.nth(1).getByRole("textbox", { name: "Find", exact: true })).toHaveValue("")
      await expect(boxes.first().getByRole("textbox", { name: "Replace with", exact: true })).toHaveValue("Message")
      // Another ready search must wait while the first replacement is in flight, so
      // every replacement joins the open panel's same group even over a slow connection.
      const otherReplace = boxes.nth(1).getByRole("button", { name: "Replace all", exact: true })
      await boxes.nth(1).getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
      await boxes.nth(1).getByRole("textbox", { name: "Replace with", exact: true }).fill("Waiting")
      await expect(otherReplace).toBeEnabled()
      const scopes = ["Messages", "Swipes", "Summaries"] as const
      for (const [index, scope] of scopes.entries()) {
        const box = boxes.nth(index)
        await box.getByRole("textbox", { name: "Find", exact: true }).fill("Aria")
        await box
          .getByRole("textbox", { name: "Replace with", exact: true })
          .fill(["Message", "Swipe", "Summary"][index]!)
        const lookIn = box.getByRole("group", { name: "Look in", exact: true })
        for (const other of scopes.filter((item) => item !== scope))
          await lookIn.getByRole("button", { name: other, exact: true }).click()
        await expect(lookIn.getByRole("button", { name: scope, exact: true })).toHaveAttribute("aria-pressed", "true")
        await expect(box.getByRole("status")).toContainText(
          index === 0
            ? "1 in messages, 0 in swipes, 0 in summaries"
            : index === 1
              ? "0 in messages, 1 in swipes, 0 in summaries"
              : "0 in messages, 0 in swipes, 1 in summaries"
        )
        await box.getByRole("button", { name: index === 0 ? "Replace" : "Replace all", exact: true }).click()
        if (index === 0) {
          await expect.poll(() => held.length).toBe(1)
          try {
            await expect(otherReplace).toBeDisabled()
          } finally {
            holding = false
            for (const send of held.splice(0)) send()
          }
        }
        await expect(box.getByRole("status")).toContainText("0 in messages, 0 in swipes, 0 in summaries")
      }
      const actual = await withCookie(server(), cookie, (api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: chat.id,
            leafSlotId: entry.slotId,
            range: { _tag: "Bottom" },
            limit: 100
          })
          const versions = yield* api.ListVersions({ slotId: entry.slotId })
          const result = yield* api.GetSummary({ summaryId: Schema.decodeUnknownSync(SummaryId)(summary.id) })
          return {
            selected: path.entries[0]!.version.content,
            versions: versions.map((version) => version.content),
            summary: result.content
          }
        })
      )
      expect(actual.selected).toBe("Message's selected message.")
      expect(actual.versions).toContain("Swipe's other version.")
      expect(actual.summary).toBe("Summary's summary.")
      await boxes.last().getByRole("button", { name: "Remove this search and replace" }).click()
      await boxes.last().getByRole("button", { name: "Remove this search and replace" }).click()
      await expect(boxes).toHaveCount(1)
      await expect(panel.getByRole("button", { name: "Remove this search and replace" })).toHaveCount(0)
    })
