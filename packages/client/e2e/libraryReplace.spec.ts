// Search and replace across the library (features/editor/LibraryReplace.tsx): the library's
// Search and replace button opens the panel under its actions; Find lists every entry with a
// match, with counts per kind; an entry left unticked keeps its text; Replace writes the rest
// and offers Undo; the URL keeps the panel and the text found through a reload; Recent replaces
// undoes a replace.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { expectLayout } from "./support/layoutAudit.ts"
import { replaceEditorText, expectTextBox } from "./support/textbox.ts"
import { loginCookie, withCookie, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
let ids = { mira: "", odo: "" }
let cookie = ""
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)
test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
  ids = await admin((api) =>
    Effect.gen(function* () {
      const mira = yield* api.CreateCard({
        label: "Mira",
        name: "Mira",
        description: "{{char}} keeps the lighthouse on the northern cape, where {{char}} watches the ships come in."
      })
      const odo = yield* api.CreateCard({ label: "Odo", name: "Odo", description: "{{char}} sails at dawn." })
      yield* api.CreateSharedNote({ title: "Harbour", content: "Ask {{char}} about the tide." })
      yield* api.CreateLorebook({ label: "Cape lore" })
      return { mira: mira.id, odo: odo.id }
    })
  )
})

const description = (refId: string) =>
  admin((api) => Effect.map(api.OpenEditor({ refId: refId as never }), (opened) => opened.doc.description as string))

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`library search and replace at ${width} in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library`)
      const button = page.getByRole("button", { name: "Search and replace", exact: true })
      await expect(button).toHaveAttribute("aria-pressed", "false")
      await button.click()
      await expect(button).toHaveAttribute("aria-pressed", "true")
      const panel = page.getByRole("region", { name: "Search and replace across the library" })
      await panel.getByRole("textbox", { name: "Find", exact: true }).fill("{{char}}")
      await panel.getByRole("textbox", { name: "Replace with", exact: true }).fill("Mira")
      await panel.getByRole("button", { name: "Find", exact: true }).click()
      const hits = panel.getByRole("list", { name: "Entries found" }).locator("[data-library-hit]")
      await expect(hits).toHaveCount(3)
      await expect(panel.locator('[data-kind-count="card"]')).toHaveText("Cards · 3 in 2")
      await expect(panel.locator('[data-kind-count="note"]')).toHaveText("Notes · 1 in 1")
      await expect(panel.locator(`[data-library-hit="${ids.mira}"]`).locator("del").first()).toHaveText("{{char}}")
      await expect(panel.locator(`[data-library-hit="${ids.mira}"]`).locator("ins").first()).toHaveText("Mira")
      expect(new URL(page.url()).searchParams.get("replace")).toBe("open")
      expect(new URL(page.url()).searchParams.get("find")).toBe("{{char}}")

      // Odo is left out; Mira's one field is shown.
      await panel.getByRole("checkbox", { name: "Replace in Odo", exact: true }).click()
      await panel.locator(`[data-library-hit="${ids.mira}"]`).getByRole("button", { name: "1 field" }).click()
      await expect(panel.getByRole("list", { name: "Fields of Mira" })).toContainText("Description · 2 matches")
      await expectLayout(page, info, `library-replace-${width}-${theme}`, { scope: "#library-replace" })
      await page.screenshot({ path: info.outputPath(`preview-${width}-${theme}.png`), fullPage: true })

      await panel.getByRole("button", { name: "Replace 3", exact: true }).click()
      await expect(panel.getByText("Replaced 3 matches in 2 entries.")).toBeVisible()
      await expect(hits).toHaveCount(1)
      expect(await description(ids.mira)).toBe(
        "Mira keeps the lighthouse on the northern cape, where Mira watches the ships come in."
      )
      expect(await description(ids.odo)).toBe("{{char}} sails at dawn.")

      // A reload keeps the panel open on the same text.
      await page.reload()
      const again = page.getByRole("region", { name: "Search and replace across the library" })
      await expect(again.getByRole("textbox", { name: "Find", exact: true })).toHaveValue("{{char}}")

      // Recent replaces takes it back.
      await again.getByText("Recent replaces").click()
      const recent = again.getByRole("list", { name: "Recent replaces" }).locator("li").first()
      await expect(recent).toContainText("Replaced “{{char}}” with “Mira” across the library")
      await recent.getByRole("button", { name: "Undo" }).click()
      await expect(again.getByText("Undid it in 2 entries.")).toBeVisible()
      await expect(recent).toContainText("undone")
      expect(await description(ids.mira)).toContain("{{char}} keeps the lighthouse")

      // Closing it takes it out of the URL.
      await again.getByRole("button", { name: "Close" }).click()
      await expect(again).toHaveCount(0)
      expect(new URL(page.url()).searchParams.get("replace")).toBeNull()
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a replace skips an entry with unsaved changes and says so at ${width} in ${theme}`, async ({
      page
    }, info) => {
      test.setTimeout(120_000)
      const word = `zephyr${width}${theme}`
      const made = await admin((api) =>
        Effect.gen(function* () {
          const clean = yield* api.CreateCard({
            label: `Clean ${word}`,
            name: "Clean",
            description: `The ${word} blows.`
          })
          const open = yield* api.CreateCard({ label: `Open ${word}`, name: "Open", description: `The ${word} rests.` })
          const opened = yield* api.OpenEditor({ refId: open.id })
          yield* api.SaveEditorDraft({
            draftId: null,
            expectedSession: null,
            refId: open.id,
            field: JSON.stringify(["description"]),
            content: `The ${word} rests, still being typed.`,
            expectedRowVersion: null,
            baseRevisionId: opened.ref.headRevisionId
          })
          return { clean: clean.id, open: open.id }
        })
      )
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library?replace=open`)
      const panel = page.getByRole("region", { name: "Search and replace across the library" })
      await panel.getByRole("textbox", { name: "Find", exact: true }).fill(word)
      await panel.getByRole("textbox", { name: "Replace with", exact: true }).fill("breeze")
      await panel.getByRole("button", { name: "Find", exact: true }).click()
      const hits = panel.getByRole("list", { name: "Entries found" }).locator("[data-library-hit]")
      await expect(hits).toHaveCount(2)
      // The open entry is listed, marked, and can't be ticked.
      const openHit = panel.locator(`[data-library-hit="${made.open}"]`)
      await expect(openHit.getByText("Unsaved changes, skipped")).toBeVisible()
      await expect(openHit.getByRole("checkbox", { name: "Replace in Open", exact: true })).toBeDisabled()
      await panel.getByRole("button", { name: "Replace 1", exact: true }).click()
      await expect(panel.getByText("Replaced 1 match in 1 entry.")).toBeVisible()
      const skipped = panel.getByRole("list", { name: "Skipped entries" })
      await expect(skipped).toContainText("It has unsaved changes, so it was skipped.")
      const link = skipped.getByRole("link", { name: "Open", exact: true })
      await expect(link).toBeVisible()
      await expectLayout(page, info, `library-replace-skipped-${width}-${theme}`, { scope: "#library-replace" })
      expect(await description(made.clean)).toBe(`The breeze blows.`)
      expect(await description(made.open)).toBe(`The ${word} rests.`)
      // The link opens its editor, where the unsaved changes still are.
      await link.click()
      await expect(page).toHaveURL(new RegExp(`/library/${made.open}`))
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`a second tab's debounced text is skipped at replace time at ${width} ${theme}`, async ({
      page,
      context
    }, info) => {
      test.setTimeout(120_000)
      const word = `pending${width}${theme}`
      const made = await admin((api) =>
        Effect.gen(function* () {
          const card = yield* api.CreateCard({
            label: `Pending ${word}`,
            name: "Pending",
            description: `The ${word} rests.`
          })
          return card.id
        })
      )
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.goto(`${server().url}/library?replace=open`)
      const panel = page.getByRole("region", { name: "Search and replace across the library" })
      await panel.getByRole("textbox", { name: "Find", exact: true }).fill(word)
      await panel.getByRole("textbox", { name: "Replace with", exact: true }).fill("breeze")
      await panel.getByRole("button", { name: "Find", exact: true }).click()
      await expect(panel.getByRole("button", { name: "Replace 1", exact: true })).toBeEnabled()
      const editor = await context.newPage()
      await editor.setViewportSize({ width, height: 900 })
      await editor.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await editor.goto(`${server().url}/library/${made}`)
      const text = editor.getByRole("textbox", { name: "Description", exact: true })
      await expect(text).toBeVisible()
      // Freeze this tab's debounce; IndexedDB still stores the exact typed text.
      const now = new Date()
      await editor.clock.install({ time: now })
      await editor.clock.pauseAt(new Date(now.getTime() + 10))
      await replaceEditorText(text, `The ${word} rests, typed but not sent.`)
      await expectTextBox(text, `The ${word} rests, typed but not sent.`)
      const before = await admin((api) => api.OpenEditor({ refId: made }))
      expect(before.drafts.filter((d) => d.status === "active")).toHaveLength(0)
      await panel.getByRole("button", { name: "Replace 1", exact: true }).click()
      await expect(panel.locator(`[data-library-skipped="${made}"]`)).toContainText(
        "It has unsaved changes, so it was skipped."
      )
      expect(await description(made)).toBe(`The ${word} rests.`)
      await expectTextBox(text, `The ${word} rests, typed but not sent.`)
      await editor.clock.resume()
      await expectLayout(page, info, `pending-replace-${width}-${theme}`, { scope: "#library-replace" })
      await editor.close()
    })

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`replace lists retained script approval and Undo restores it at ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      const word = `script${width}${theme}`
      const refId = await admin((api) =>
        Effect.gen(function* () {
          const card = yield* api.CreateCard({ label: `Script ${word}`, name: "Script" })
          const opened = yield* api.OpenEditor({ refId: card.id })
          const saved = yield* api.SaveEditorDraft({
            refId: card.id,
            draftId: null,
            expectedSession: null,
            expectedRowVersion: null,
            baseRevisionId: opened.ref.headRevisionId,
            field: '=["regex"]',
            content: JSON.stringify([
              {
                id: "one",
                name: word,
                find_regex: "/x/g",
                replace_string: word,
                trim_strings: [],
                placement: [2],
                disabled: false,
                markdown_only: false,
                prompt_only: false,
                run_on_edit: false,
                substitute_regex: "none",
                min_depth: null,
                max_depth: null
              }
            ])
          })
          const draft = saved
          const current = yield* api.OpenEditor({ refId: card.id })
          yield* api.CommitEditorDrafts({
            refId: card.id,
            expectedRowVersion: current.ref.rowVersion,
            fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
            message: null
          })
          const head = yield* api.OpenEditor({ refId: card.id })
          yield* api.SetRegexApproval({ refId: card.id, approved: true, expectedRowVersion: head.ref.rowVersion })
          return card.id
        })
      )
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/library?replace=open`)
      const panel = page.getByRole("region", { name: "Search and replace across the library" })
      await panel.getByRole("textbox", { name: "Find", exact: true }).fill(word)
      await panel.getByRole("textbox", { name: "Replace with", exact: true }).fill("beacon")
      await panel.getByRole("button", { name: "Find", exact: true }).click()
      await panel.getByRole("button", { name: "Replace 2", exact: true }).click()
      await expect(panel.getByRole("list", { name: "Scripts kept approved" })).toContainText("beacon")
      await expectLayout(page, info, `approved-replace-${width}-${theme}`, { scope: "#library-replace" })
      await panel.getByRole("button", { name: "Undo", exact: true }).first().click()
      const restored = await admin((api) => api.OpenEditor({ refId }))
      expect(restored.doc.regex_approved).toBe(true)
      expect((restored.doc.regex as Array<{ name: string }>)[0]!.name).toBe(word)
    })
