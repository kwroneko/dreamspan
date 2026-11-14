// The re-import preview (ARCHITECTURE.md §13 "Re-import preview"): choosing an ST folder whose
// chats are already here shows, before anything is written, what importing does to each of
// them; a file can be skipped, and an import confirmed after the chats changed is refused and
// checked again. Every file here is made up.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { card, header, jsonl, message } from "../../server/test/support/stFolder.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)

let base = ""
test.beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "rp-st-plan-"))
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
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
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

      // The branch file skipped.
      await sideRow.getByRole("button", { name: "Skip" }).click()
      await expect(sideRow.getByRole("button", { name: "Skip" })).toHaveAttribute("aria-pressed", "true")
      await expect(preview.getByText("Importing adds 2 messages and 1 swipe to them.")).toBeVisible()

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
      await expectLayout(page, info, `st-reimport-preview-${width}-${theme}`, {
        scope: 'section[aria-label="Chats already here"]'
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

      // A change here after the check: the import is refused and the chats are checked again.
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
      await expect(page.getByText("Your chats changed since this check", { exact: false })).toBeVisible()
      await expect(mainRow).toContainText("2 messages kept as you left them")
      await expect(sideRow.getByRole("button", { name: "Skip" })).toHaveAttribute("aria-pressed", "false")
      await sideRow.getByRole("button", { name: "Skip" }).click()
      await page.getByRole("button", { name: "Import", exact: true }).click()
      await expect(page.getByRole("list", { name: "Imported" })).toContainText("Chats")

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

test("a folder picked in the browser: the preview reads only the files it asks for", async ({ page }) => {
  const main = "Bridge picked"
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
    if (request.url().includes("/st-import/plan-file")) sent.push(new URL(request.url()).searchParams.get("path") ?? "")
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/import/st`)
  await page.getByRole("button", { name: "Import ST data again" }).click()
  await page.getByLabel("Choose the folder").setInputFiles(join(root, "ST"))
  const preview = page.getByRole("region", { name: "Chats already here" })
  await expect(preview.getByText("Importing adds 2 messages and 1 swipe to them.")).toBeVisible()
  // Only the chat file already here went to the server for the check; the card didn't.
  expect(sent).toEqual([`chats/Alice/${main}.jsonl`])
  await page.getByRole("button", { name: "Import", exact: true }).click()
  await expect(page.getByRole("list", { name: "Imported" })).toContainText("Chats")
  const after = await admin((api) =>
    Effect.map(
      api.ReadPath({ chatId: chatId as ChatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
      (path) => path.entries.length
    )
  )
  expect(after).toBe(12)
})
