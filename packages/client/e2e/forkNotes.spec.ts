// Synthetic notes only. Exercise the real RPC, registered message action and both diff layouts.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { textField } from "@rp/shared/editing.ts"
import { Effect } from "effect"
import { asUser, type Client } from "./support/rpc.ts"
import { messageMenu } from "./support/message.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) =>
  asUser(server(), ADMIN.handle, ADMIN.password, use)
let vite: ChildProcess | undefined
let url: string

test.beforeAll(async () => {
  if (!process.env.FORK_NOTES_DEV) {
    url = server().url
    return
  }
  const port = 33000 + Math.floor(Math.random() * 1000)
  url = `http://127.0.0.1:${port}`
  vite = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "packages/client", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: resolve(import.meta.dirname, "../../.."), env: { ...process.env, RP_SERVER: server().url }, stdio: "ignore" }
  )
  await expect
    .poll(
      async () =>
        fetch(url).then(
          (r) => r.ok,
          () => false
        ),
      { timeout: 30000 }
    )
    .toBe(true)
})
test.afterAll(async () => {
  vite?.kill("SIGTERM")
})

const seeded = () =>
  admin((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: "The harbour treaty" })
      const a = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: null,
        content: "We reached the harbour before dawn.",
        branch: false
      })
      if (a._tag !== "Posted") throw new Error("expected posted")
      const treaty = yield* api.CreateChatNote({ chatId: chat.id, title: "Treaty between the cities" })
      const narration = yield* api.CreateChatNote({ chatId: chat.id, title: "Narration style" })
      const save = Effect.fnUntraced(function* (
        refId: typeof treaty.id,
        slotId: typeof a.entry.slotId,
        content: string
      ) {
        const chatNote = { chatId: chat.id, forkId: chat.currentForkId!, slotId }
        const opened = yield* api.OpenEditor({ refId, chatNote })
        const draft = yield* api.SaveEditorDraft({
          refId,
          field: textField(["content"]),
          draftId: null,
          content,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: opened.ref.headRevisionId
        })
        yield* api.CommitEditorDrafts({
          refId,
          chatNote,
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
      })
      yield* save(
        treaty.id,
        a.entry.slotId,
        "The northern cities are at war.\nThe harbour is closed to foreign ships.\nMira has not met the envoy."
      )
      yield* save(narration.id, a.entry.slotId, "Write in past tense.\nKeep dialogue concise.")
      for (const note of [treaty, narration])
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: a.entry.slotId,
          change: { _tag: "Note", entityId: note.entityId, active: true }
        })
      const b = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: a.entry.slotId,
        content: "Mira signed the treaty with the envoy.",
        branch: false
      })
      if (b._tag !== "Posted") throw new Error("expected posted")
      yield* save(
        treaty.id,
        b.entry.slotId,
        "The northern cities are at peace.\nThe harbour welcomes foreign ships.\nMira trusts the envoy."
      )
      yield* save(
        narration.id,
        b.entry.slotId,
        "Write in past tense.\nKeep dialogue concise.\nAvoid repeating character names in adjacent sentences."
      )
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: b.entry.slotId,
        change: { _tag: "Note", entityId: treaty.entityId, active: false }
      })
      return { chat, treaty, narration, a: a.entry, b: b.entry }
    })
  )

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`fork note choices ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180000)
      const h = await seeded()
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${url}/chats/${h.chat.id}`)
      const message = page.getByTestId("messages").locator("[data-slot]").filter({ hasText: h.a.version.content })
      // Message actions are named independently of their desktop toolbar placement.
      await expect(page.getByTestId("messages").getByText(h.a.version.content)).toBeVisible()
      await messageMenu(message, "Branch from here")
      const dialog = page.getByRole("dialog", { name: "Branch from here", exact: true })
      const all = dialog.getByRole("group", { name: "Set all notes", exact: true })
      const treaty = dialog.getByRole("group", { name: "Inherit Treaty between the cities", exact: true })
      const narration = dialog.getByRole("group", { name: "Inherit Narration style", exact: true })
      await expect(treaty.getByRole("button", { name: "As it was then" })).toHaveAttribute("aria-pressed", "true")
      if (width === 1440 && theme === "light") {
        await all.getByRole("button", { name: "As it is now" }).click()
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
        await expect(dialog).not.toBeVisible()
        expect((await admin((api) => api.ListForks({ chatId: h.chat.id }))).length).toBe(1)
        await messageMenu(message, "Branch from here")
        await expect(treaty.getByRole("button", { name: "As it was then" })).toHaveAttribute("aria-pressed", "true")
        await expect(narration.getByRole("button", { name: "As it was then" })).toHaveAttribute("aria-pressed", "true")
      }
      await all.getByRole("button", { name: "As it is now" }).click()
      await expect(narration.getByRole("button", { name: "As it is now" })).toHaveAttribute("aria-pressed", "true")
      await treaty.getByRole("button", { name: "As it was then" }).click()
      await expect(dialog.getByText("Set all notes · Mixed choices")).toBeVisible()
      await dialog.locator("summary").first().click()
      await expect(dialog.getByRole("textbox", { name: "As it was then" })).toBeVisible()
      const shot = async (name: string) => {
        if (!process.env.SCREENSHOT_DIR) return
        mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({
          path: join(process.env.SCREENSHOT_DIR, `${name}-${width}-${theme}.png`),
          animations: "disabled"
        })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      }
      await shot("accordion")
      if (process.env.FORK_NOTES_DEV) {
        await dialog.getByRole("switch", { name: "Development: open diffs with buttons" }).click()
        await shot("buttons")
        await dialog.getByRole("button", { name: "Compare Treaty between the cities" }).click()
        await expect(page.getByRole("dialog", { name: "Treaty between the cities", exact: true })).toBeVisible()
        await shot("button-diff")
        await page.getByRole("button", { name: "Back to notes" }).click()
      }
      await dialog.getByRole("button", { name: "Create fork", exact: true }).click()
      await expect(dialog).not.toBeVisible()
      const fork = await admin((api) => api.GetChat({ chatId: h.chat.id }))
      expect(fork.currentForkId).not.toBe(h.chat.currentForkId)
      const opened = await admin((api) =>
        api.OpenEditor({
          refId: h.treaty.id,
          chatNote: { chatId: h.chat.id, forkId: fork.currentForkId!, slotId: h.a.slotId }
        })
      )
      expect(opened.doc.content).toContain("at war")
      const chosen = await admin((api) =>
        api.OpenEditor({
          refId: h.narration.id,
          chatNote: { chatId: h.chat.id, forkId: fork.currentForkId!, slotId: h.a.slotId }
        })
      )
      expect(chosen.doc.content).toContain("Avoid repeating")
      const inherited = await admin((api) =>
        api.ListChatNotes({ chatId: h.chat.id, forkId: fork.currentForkId!, slotId: h.a.slotId })
      )
      expect(inherited.find((note) => note.ref.id === h.treaty.id)?.active).toBe(true)
      const parent = await admin((api) =>
        api.ListChatNotes({ chatId: h.chat.id, forkId: h.chat.currentForkId!, slotId: h.b.slotId })
      )
      expect(parent.find((note) => note.ref.id === h.treaty.id)?.active).toBe(false)
    })
  }
