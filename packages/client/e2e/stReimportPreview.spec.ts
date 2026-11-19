// The re-import preview (ARCHITECTURE.md §13 "Re-import preview"): choosing an ST folder whose
// chats are already here shows, before anything is written, what importing does to each of
// them; a file can be skipped, and a file whose chat changed after the check is refused, its
// chat left as it was, and the report offers to check again. Every file here is made up.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { loginCookie, withCookie } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let cookie: string
const admin = <A>(use: Parameters<typeof withCookie<A>>[2]) => withCookie(server(), cookie, use)

let base = ""
test.beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "rp-st-plan-"))
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})
test.beforeEach(async () => {
  await admin((api) =>
    api.SetDisplayPrefs({ prefs: { chatDensity: process.env.STACK_DENSITY === "compact" ? "compact" : "comfortable" } })
  )
})
test.afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const USER = "ST/data/default-user"

const turns = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    message({
      name: i % 2 ? "Sam" : "Alice",
      user: i % 2 === 1,
      mes: `Turn ${i}: the lantern swung over the bridge.`,
      minute: i,
      ...(i % 2 ? {} : { swipes: [`Turn ${i}: the lantern swung over the bridge.`] })
    })
  )

/** In ST since: another swipe on message 4, chosen there, and two messages more. */
const later = () => {
  const lines = turns(12)
  lines[4] = message({
    name: "Alice",
    mes: "Turn 4, written again: the river ran loud.",
    minute: 4,
    swipes: ["Turn 4: the lantern swung over the bridge.", "Turn 4, written again: the river ran loud."],
    swipeId: 1
  })
  return lines
}

const write = (root: string, files: Record<string, Uint8Array>) => {
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, USER, path)), { recursive: true })
    writeFileSync(join(root, USER, path), bytes)
  }
}

// A picked upload opens its new report before sendUpload finishes. The previous report can
// still say Imported (or its refusal list can disappear) before any new messages are committed.
const importPicked = async (page: Page) => {
  const before = new URL(page.url()).searchParams.get("job")
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("job")).not.toBe(before)
  const importId = new URL(page.url()).searchParams.get("job")!
  await expect
    .poll(() => admin((api) => Effect.map(api.GetStImport({ importId }), (detail) => detail.job.status)))
    .toBe("complete")
}

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: the preview shows what importing does, and the import keeps to it`, async ({
      page
    }, info) => {
      const tag = `${width} ${theme}`
      const main = `Bridge ${tag}`
      const side = `Ford ${tag}`
      const root = mkdtempSync(join(base, "st-"))
      write(root, {
        "characters/Alice.png": card("Alice", "Synthetic greeting."),
        [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...turns(10)])
      })
      const chatId = await admin((api) =>
        Effect.gen(function* () {
          const { importId } = yield* api.StartStPathImport({ path: root, prefix: `${USER}/` })
          for (;;) {
            if ((yield* api.GetStImport({ importId })).job.status !== "running") break
            yield* Effect.sleep(50)
          }
          const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === main)!
          // Here since: message 8 hidden.
          const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
          yield* api.SetMessageHidden({ slotId: path.entries[8]!.slotId, hidden: true })
          return chat.id
        })
      )
      write(root, {
        [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...later()]),
        // A new branch file from message 6, which the user may skip.
        [`chats/Alice/${side}.jsonl`]: jsonl([
          header({ main_chat: main }),
          ...turns(7),
          message({ name: "Sam", user: true, mes: "Sam takes the ford instead.", minute: 7 })
        ])
      })

      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      await page.setViewportSize({ width, height: 900 })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/import/st`)
      await page.getByRole("button", { name: "Import ST data again" }).click()
      await page.getByLabel("Folder path").fill(join(root, "ST/data"))
      await page.getByRole("button", { name: "Look in this folder" }).click()

      const preview = page.getByRole("region", { name: "Chats already here" })
      await expect(preview.getByText("Importing adds 3 messages and 1 swipe to them.")).toBeVisible()
      const rows = preview.getByRole("list", { name: "Files for chats already here" }).getByRole("listitem")
      const mainRow = rows.filter({ hasText: main }).first()
      await expect(mainRow).toContainText("Imported before.")
      await expect(mainRow).toContainText(
        "2 new messages · 1 new swipe · 1 shown swipe changes · 1 message kept as you left it"
      )
      const sideRow = rows.filter({ hasText: side }).first()
      await expect(sideRow).toContainText(`A new branch of ${main}.`)
      await expect(sideRow).toContainText("1 new message · 1 new branch")
      await mainRow.getByText("4 changed messages").click()
      const changed = mainRow.getByRole("list", { name: `Changed messages in ${main}` })
      await expect(changed.getByRole("listitem")).toHaveCount(4)
      await expect(changed.getByRole("listitem").nth(1)).toContainText("Kept: you hid or showed it here")
      await expect(page.getByRole("button", { name: "Import", exact: true })).toBeEnabled()

      // Skipping the earlier parent invalidates the later branch's displayed counts.
      await mainRow.getByRole("button", { name: "Skip" }).click()
      await expect(
        preview.getByText("Message counts cannot be predicted while an earlier file for the same chat is skipped.")
      ).toBeVisible()
      await expect(sideRow).toContainText("Its message counts and changes cannot be predicted here.")
      await expect(sideRow.getByText("1 new message · 1 new branch", { exact: true })).toHaveCount(0)
      await expect(
        preview.getByText("Counts assume each file can be linked to a card.", { exact: false })
      ).toBeVisible()
      await expectLayout(page, info, `st-reimport-skipped-parent-${width}-${theme}`)
      await mainRow.getByRole("button", { name: "Include" }).click()

      // The branch file skipped.
      await sideRow.getByRole("button", { name: "Skip" }).click()
      await expect(sideRow.getByRole("button", { name: "Skip" })).toHaveAttribute("aria-pressed", "true")
      await expect(preview.getByText("Importing adds 2 messages and 1 swipe to them.")).toBeVisible()

      await page.screenshot({ path: info.outputPath(`preview-${width}-${theme}.png`), animations: "disabled" })
      const shots = process.env.SCREENSHOT_DIR
      if (shots) {
        await preview.scrollIntoViewIfNeeded()
        await page.screenshot({
          path: resolve(shots, `st-reimport-preview-${width}-${theme}.png`),
          animations: "disabled"
        })
        await preview.screenshot({
          path: resolve(shots, `st-reimport-preview-section-${width}-${theme}.png`),
          animations: "disabled"
        })
      }
      await expectLayout(page, info, `st-reimport-preview-${width}-${theme}`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

      await expect(preview).toContainText("New-chat counts are estimates.")
      await expect(preview).toContainText(
        "a file needing your choice may wait in the report or be listed under Not imported."
      )
      // A change here after the check: the file is refused, nothing of it written, and the
      // report offers to check the folder again.
      await admin((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: chatId as ChatId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          yield* api.SetMessageHidden({ slotId: path.entries[2]!.slotId as SlotId, hidden: true })
        })
      )
      await page.getByRole("button", { name: "Import", exact: true }).click()
      const refused = page.getByRole("list", { name: "Not imported" })
      await expect(refused).toContainText(`${main}.jsonl`)
      await expect(page.getByText("This chat changed after the check, so it wasn't imported.")).toBeVisible()
      expect(
        await admin((api) =>
          Effect.map(
            api.ReadPath({ chatId: chatId as ChatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
            (path) => path.entries.length
          )
        )
      ).toBe(10)
      await expectLayout(page, info, `st-reimport-refused-${width}-${theme}`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      await page.getByRole("button", { name: "Check again" }).click()
      await expect(mainRow).toContainText("2 messages kept as you left them")
      await expect(sideRow.getByRole("button", { name: "Skip" })).toHaveAttribute("aria-pressed", "false")
      await sideRow.getByRole("button", { name: "Skip" }).click()
      await page.getByRole("button", { name: "Import", exact: true }).click()
      await expect(page.getByRole("list", { name: "Imported" }).first()).toContainText("Chats")
      await expect(refused).toHaveCount(0)

      const after = await admin((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: chatId as ChatId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          return path.entries.map((entry) => ({ text: entry.version.content, hidden: entry.hiddenByUser }))
        })
      )
      expect(after).toHaveLength(12)
      expect(after[4]!.text).toBe("Turn 4, written again: the river ran loud.")
      expect(after[8]!.hidden).toBe(true)
      // The skipped branch file didn't come in.
      expect(
        await admin((api) => Effect.map(api.ListForks({ chatId: chatId as ChatId }), (forks) => forks.length))
      ).toBe(1)
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`${width} ${theme}: picked folders check, refuse and check again`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
      const main = `Bridge picked ${width} ${theme}`
      const root = mkdtempSync(join(base, "st-"))
      write(root, {
        "characters/Alice.png": card("Alice", "Synthetic greeting."),
        [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...turns(10)])
      })
      const chatId = await admin((api) =>
        Effect.gen(function* () {
          const { importId } = yield* api.StartStPathImport({ path: root, prefix: `${USER}/` })
          for (;;) {
            if ((yield* api.GetStImport({ importId })).job.status !== "running") break
            yield* Effect.sleep(50)
          }
          return (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === main)!.id
        })
      )
      write(root, { [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...later()]) })
      const sent: Array<string> = []
      page.on("request", (request) => {
        if (request.url().includes("/st-import/plan-file"))
          sent.push(new URL(request.url()).searchParams.get("path") ?? "")
      })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/import/st`)
      await page.getByRole("button", { name: "Import ST data again" }).click()
      await page.getByLabel("Choose the folder").setInputFiles(join(root, "ST"))
      const preview = page.getByRole("region", { name: "Chats already here" })
      await expect(preview.getByText("Importing adds 2 messages and 1 swipe to them.")).toBeVisible()
      // Only the chat file already here went to the server for the check; the card didn't.
      expect(sent).toEqual([`chats/Alice/${main}.jsonl`])
      // A second picked folder can have the same ST prefix; it still needs a new check.
      const other = mkdtempSync(join(base, "st-other-"))
      write(other, {
        "characters/Alice.png": card("Alice", "Synthetic greeting."),
        [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...turns(14)])
      })
      await page.getByLabel("Choose the folder").setInputFiles(join(other, "ST"))
      await expect(preview.getByText("Importing adds 4 messages and 0 swipes to them.")).toBeVisible()
      await importPicked(page)
      await expect(page.getByRole("list", { name: "Imported" })).toContainText("Chats")
      const after = await admin((api) =>
        Effect.map(
          api.ReadPath({ chatId: chatId as ChatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
          (path) => path.entries.length
        )
      )
      expect(after).toBe(14)

      // The picked-folder refusal must offer a fresh pick, rather than a server path.
      write(other, { [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...turns(16)]) })
      await page.getByRole("button", { name: "Import ST data again" }).click()
      await page.getByLabel("Choose the folder").setInputFiles(join(other, "ST"))
      await expect(preview.getByText("Importing adds 2 messages and 0 swipes to them.")).toBeVisible()
      await admin((api) =>
        Effect.gen(function* () {
          const path = yield* api.ReadPath({
            chatId: chatId as ChatId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          yield* api.SetMessageHidden({ slotId: path.entries[2]!.slotId, hidden: true })
        })
      )
      await page.getByRole("button", { name: "Import", exact: true }).click()
      const refused = page.getByRole("list", { name: "Not imported" })
      await expect(refused).toContainText(`${main}.jsonl`)
      await expectLayout(page, info, `st-reimport-picked-refused-${width}-${theme}`)
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: resolve(process.env.SCREENSHOT_DIR, `st-reimport-picked-refused-${width}-${theme}.png`),
          animations: "disabled"
        })
      await page.getByRole("button", { name: "Check again" }).click()
      await expect(page.getByLabel("Choose the folder")).toBeVisible()
      await page.getByLabel("Choose the folder").setInputFiles(join(other, "ST"))
      await expect(preview.getByText("Importing adds 2 messages and 0 swipes to them.")).toBeVisible()
      await importPicked(page)
      await expect(refused).toHaveCount(0)
      const final = await admin((api) =>
        Effect.map(
          api.ReadPath({ chatId: chatId as ChatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
          (path) => path.entries.length
        )
      )
      expect(final).toBe(16)
    })

test("untrusted message text stays literal in preview details", async ({ page }) => {
  const main = "Literal preview"
  const root = mkdtempSync(join(base, "st-literal-"))
  write(root, {
    "characters/Alice.png": card("Alice", "Synthetic greeting."),
    [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...turns(2)])
  })
  await admin((api) =>
    Effect.gen(function* () {
      const { importId } = yield* api.StartStPathImport({ path: root, prefix: `${USER}/` })
      for (;;) {
        if ((yield* api.GetStImport({ importId })).job.status !== "running") break
        yield* Effect.sleep(50)
      }
    })
  )
  const payload =
    '<img src="x" onerror="window.previewTextExecuted=true"><script>window.previewTextExecuted=true</script>'
  const changed = turns(4)
  changed[2] = message({ name: "Alice", mes: payload, minute: 2 })
  write(root, { [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...changed]) })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import/st`)
  await page.getByRole("button", { name: "Import ST data again" }).click()
  await page.getByLabel("Folder path").fill(join(root, "ST/data"))
  await page.getByRole("button", { name: "Look in this folder" }).click()
  const preview = page.getByRole("region", { name: "Chats already here" })
  await expect(preview.getByText("Importing adds 2 messages and 0 swipes to them.")).toBeVisible()
  await preview.getByText("2 changed messages", { exact: true }).click()
  await expect(preview.getByText(payload, { exact: true })).toBeVisible()
  await expect(preview.locator("img, script")).toHaveCount(0)
})

test("Skip all also skips files made quiet by an earlier file's predicted additions", async ({ page }) => {
  const root = mkdtempSync(join(base, "st-skip-quiet-"))
  const main = "Quiet parent"
  const side = "Quiet child"
  write(root, {
    "characters/Alice.png": card("Alice", "Synthetic greeting."),
    [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...turns(4)]),
    [`chats/Alice/${side}.jsonl`]: jsonl([header({ main_chat: main }), ...turns(4)]),
    ["chats/Alice/Extra changed.jsonl"]: jsonl([header({}), ...turns(4)])
  })
  const before = await admin((api) =>
    Effect.gen(function* () {
      const { importId } = yield* api.StartStPathImport({ path: root, prefix: `${USER}/` })
      for (;;) {
        if ((yield* api.GetStImport({ importId })).job.status !== "running") break
        yield* Effect.sleep(50)
      }
      const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === main)!
      return { importId, chatId: chat.id }
    })
  )
  write(root, {
    [`chats/Alice/${main}.jsonl`]: jsonl([header({}), ...turns(6)]),
    [`chats/Alice/${side}.jsonl`]: jsonl([header({ main_chat: main }), ...turns(6)]),
    ["chats/Alice/Extra changed.jsonl"]: jsonl([header({}), ...turns(6)])
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import/st`)
  await page.getByRole("button", { name: "Import ST data again" }).click()
  await page.getByLabel("Folder path").fill(join(root, "ST/data"))
  await page.getByRole("button", { name: "Look in this folder" }).click()
  const preview = page.getByRole("region", { name: "Chats already here" })
  await expect(preview.getByText("Importing adds 4 messages and 0 swipes to them.")).toBeVisible()
  await preview.getByRole("button", { name: "Skip all", exact: true }).click()
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("job")).not.toBeNull()
  const importId = new URL(page.url()).searchParams.get("job")!
  expect(importId).not.toBe(before.importId)
  await expect
    .poll(() => admin((api) => Effect.map(api.GetStImport({ importId }), (detail) => detail.job.status)))
    .toBe("complete")
  const lengths = await admin((api) =>
    Effect.gen(function* () {
      const forks = yield* api.ListForks({ chatId: before.chatId })
      return yield* Effect.forEach(forks, (fork) =>
        Effect.map(
          api.ReadPath({
            chatId: before.chatId,
            forkId: fork.id,
            leafSlotId: fork.tipSlotId,
            range: { _tag: "Bottom" },
            limit: 100
          }),
          (read) => read.entries.length
        )
      )
    })
  )
  expect(lengths.every((n) => n === 4)).toBe(true)
})
