// Synthetic notes only. Exercise the real RPC, registered message action and both diff layouts.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { textField } from "@dreamspan/shared/editing.ts"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { messageMenu } from "./support/message.ts"
import { noteBlock, noteText } from "./support/notes.ts"
import { closePanel } from "./support/panel.ts"
import { expectTextBox } from "./support/textbox.ts"
import type { ChatNotePosition } from "@dreamspan/shared/editorApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
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

const TREATY_TYPED =
  "The northern cities are at peace.\nThe harbour welcomes foreign ships.\nMira trusts the envoy.\nThe envoy hides a letter."
const NARRATION_TYPED =
  "Write in past tense.\nKeep dialogue concise.\nAvoid repeating character names in adjacent sentences.\nOpen scenes with the weather."

/** Each note's unsaved text at its position, or null, read in one session (logins are rate-limited). */
const unsavedAt = (...at: ReadonlyArray<readonly [RefId, ChatNotePosition]>) =>
  admin((api) =>
    Effect.forEach(at, ([refId, chatNote]) =>
      api
        .OpenEditor({ refId, chatNote })
        .pipe(
          Effect.map(
            (opened) =>
              opened.drafts.find((d) => d.key.field === textField(["content"]) && d.status === "active")?.content ??
              null
          )
        )
    )
  )

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
          // A chat's own note's drafts are its branch's.
          scope: opened.chatNote!.scope,
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
      // Typed on at the latest message and not saved: the latest state of each (owner, 2026-11-02).
      for (const [note, content] of [
        [treaty, TREATY_TYPED],
        [narration, NARRATION_TYPED]
      ] as const) {
        const chatNote = { chatId: chat.id, forkId: chat.currentForkId!, slotId: b.entry.slotId }
        const opened = yield* api.OpenEditor({ refId: note.id, chatNote })
        const draft = opened.drafts.find((d) => d.key.field === textField(["content"]))
        yield* api.SaveEditorDraft({
          refId: note.id,
          field: textField(["content"]),
          scope: opened.chatNote!.scope,
          draftId: draft?.id ?? null,
          content,
          expectedRowVersion: draft?.rowVersion ?? null,
          expectedSession: draft?.session ?? null,
          baseRevisionId: opened.ref.headRevisionId
        })
      }
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
      // Unsaved text is the latest state: each row says so, and its comparison shows it.
      await expect(dialog.getByText("This chat · Unsaved changes")).toHaveCount(2)
      await expect(dialog).toHaveAccessibleDescription("")
      if (process.env.LAYOUT_AUDIT) await expectLayout(page, test.info(), "branch-from-here")
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
      await expect(dialog.getByText("Now · Off · unsaved changes")).toBeVisible()
      await expect(dialog.getByRole("textbox", { name: "As it is now" }).first()).toContainText(
        "The envoy hides a letter."
      )
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
      await dialog.getByRole("button", { name: "Create branch", exact: true }).click()
      await expect(dialog).not.toBeVisible()
      // Read in one session: logins are rate-limited.
      const after = await admin((api) =>
        Effect.gen(function* () {
          const fork = (yield* api.GetChat({ chatId: h.chat.id })).currentForkId!
          const at = { chatId: h.chat.id, forkId: fork, slotId: h.a.slotId }
          return {
            fork,
            treaty: yield* api.OpenEditor({ refId: h.treaty.id, chatNote: at }),
            narration: yield* api.OpenEditor({ refId: h.narration.id, chatNote: at }),
            inherited: yield* api.ListChatNotes(at),
            parent: yield* api.ListChatNotes({ chatId: h.chat.id, forkId: h.chat.currentForkId!, slotId: h.b.slotId })
          }
        })
      )
      const fork = { currentForkId: after.fork }
      expect(after.fork).not.toBe(h.chat.currentForkId)
      expect(after.treaty.doc.content).toContain("at war")
      expect(after.narration.doc.content).toContain("Avoid repeating")
      expect(after.inherited.find((note) => note.ref.id === h.treaty.id)?.active).toBe(true)
      expect(after.parent.find((note) => note.ref.id === h.treaty.id)?.active).toBe(false)
      // As it is now took the unsaved text along, and the branch it came from went back to its
      // revision; As it was then left it where it was typed.
      const made = { chatId: h.chat.id, forkId: fork.currentForkId!, slotId: h.a.slotId }
      const source = { chatId: h.chat.id, forkId: h.chat.currentForkId!, slotId: h.b.slotId }
      expect(
        await unsavedAt([h.narration.id, made], [h.narration.id, source], [h.treaty.id, made], [h.treaty.id, source])
      ).toEqual([NARRATION_TYPED, null, null, TREATY_TYPED])
    })
  }

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`unsaved note text moves to a branch ${width} ${theme}`, async ({ page }) => {
      test.setTimeout(180000)
      const h = await admin((api) =>
        Effect.gen(function* () {
          const chat = yield* api.CreateChat({ title: "The lighthouse" })
          const a = yield* api.SendMessage({
            chatId: chat.id,
            parentSlotId: null,
            content: "The lamp was lit at dusk.",
            branch: false
          })
          if (a._tag !== "Posted") throw new Error("expected posted")
          const note = yield* api.CreateChatNote({ chatId: chat.id, title: "Weather" })
          return { chat, note, a: a.entry }
        })
      )
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
      await page.emulateMedia({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem("rp.theme", value), theme)
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const shot = async (name: string) => {
        if (!process.env.SCREENSHOT_DIR) return
        mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({
          path: join(process.env.SCREENSHOT_DIR, `${name}-${width}-${theme}.png`),
          animations: "disabled"
        })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      }
      await page.goto(`${url}/chats/${h.chat.id}?panel=notes`)
      const text = await noteText(page, "Weather")
      await text.fill("Fog rolls in from the sea.")
      // Not saved: branched from the latest message, no note changed after it, so no dialog.
      if (width === 390) await closePanel(page)
      const message = page.getByTestId("messages").locator("[data-slot]").filter({ hasText: h.a.version.content })
      await messageMenu(message, "Branch from here")
      // The new branch opens at the message it was made at.
      await expect(page).toHaveURL(/[?&]slot=/)
      await expect(page.getByRole("dialog", { name: "Branch from here", exact: true })).toHaveCount(0)
      const fork = (await admin((api) => api.GetChat({ chatId: h.chat.id }))).currentForkId!
      expect(fork).not.toBe(h.chat.currentForkId)
      // The new branch has it, still unsaved.
      await page.goto(`${url}/chats/${h.chat.id}?fork=${fork}&panel=notes`)
      await expectTextBox(await noteText(page, "Weather"), "Fog rolls in from the sea.")
      await shot("carried")
      expect(await unsavedAt([h.note.id, { chatId: h.chat.id, forkId: fork, slotId: h.a.slotId }])).toEqual([
        "Fog rolls in from the sea."
      ])
      // The branch it came from went back to its revision; its edit history has the text.
      await page.goto(`${url}/chats/${h.chat.id}?fork=${h.chat.currentForkId}&panel=notes`)
      const back = await noteText(page, "Weather")
      await expectTextBox(back, "")
      await noteBlock(page, "Weather")
        .getByRole("button", { name: /^Edit history of / })
        .click()
      const history = page.getByRole("dialog", { name: /^Edit history: / })
      await expect(history.getByLabel("Text of the state")).toHaveText("Fog rolls in from the sea.")
      await shot("parent-history")
      await history.getByRole("button", { name: "Put this text in the box" }).click()
      await expect(history).toHaveCount(0)
      await expectTextBox(back, "Fog rolls in from the sea.")
    })
  }
