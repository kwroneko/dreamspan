import { level1 } from "./summaries.ts"
import { expectTextBox, textBoxValue } from "./textbox.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RefId } from "@rp/shared/library.ts"
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./server.ts"
import { expectLayout } from "./layoutAudit.ts"
import { openPanel } from "./panel.ts"

export function centerHeaderTests() {
  test.describe("center headers", () => {
    const server = serverPerFile(withAdmin)
    const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
    for (const width of [1440, 390])
      test(`aligned pages and document switching at ${width}`, async ({ page }, info) => {
        test.setTimeout(240_000)
        await page.setViewportSize({ width, height: 900 })
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const upload = async (name: string, body: unknown) => {
          const response = await page.request.post(
            `${server().url}/library/import?name=${encodeURIComponent(name)}.json`,
            {
              data: Buffer.from(JSON.stringify(body)),
              headers: { origin: server().url, "content-type": "application/octet-stream" }
            }
          )
          expect(response.status()).toBe(200)
          return ((await response.json()) as { library: { ref: { id: RefId } } }).library.ref.id
        }
        const presetA = await admin((api) => api.CreatePreset({ label: `Preset A ${width}` }))
        const presetB = await admin((api) => api.CreatePreset({ label: `Preset B ${width}` }))
        const bookA = await upload(`Book A ${width}`, {
          name: `Book A ${width}`,
          entries: { 0: { uid: 0, key: ["test"], comment: "Harbor", content: "Synthetic lore.", order: 10 } }
        })
        const bookB = await upload(`Book B ${width}`, { name: `Book B ${width}`, entries: {} })
        const fixtures = await admin((api) =>
          Effect.gen(function* () {
            const card = yield* api.CreateCard({ label: `Card ${width}`, name: `Card ${width}` })
            const card2 = yield* api.CreateCard({ label: `Other ${width}`, name: `Other ${width}` })
            const persona = yield* api.CreateCard({ label: `Persona ${width}`, name: `Persona ${width}` })
            yield* api.SetPersona({ entityId: persona.entityId, persona: true })
            const snippet = yield* api.CreateSnippet({
              chatId: null,
              title: `Snippet ${width}`,
              content: "Synthetic snippet."
            })
            const connection = yield* api.CreateConnection({
              kind: "openai-chat",
              settings: {
                name: `Connection ${width}`,
                baseUrl: "http://127.0.0.1:1/v1",
                compat: {},
                cacheTtlS: null,
                maxConcurrent: null,
                presetOverrideRefId: null
              }
            })
            const note = yield* api.CreateSharedNote({ title: `Note ${width}`, content: "Synthetic note." })
            const chat = yield* api.CreateChat({ title: `Chat ${width}` })
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
            yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card2.entityId } })
            const chatNote = yield* api.CreateChatNote({ chatId: chat.id, title: `Chat note ${width}` })
            const sent = yield* api.SendMessage({
              chatId: chat.id,
              parentSlotId: null,
              branch: false,
              content: "Synthetic scene.",
              reply: false
            })
            if (sent._tag !== "Posted") throw new Error("Expected a posted fixture")
            const sibling = yield* api.CreateChat({ title: `Chat ${width}` })
            yield* api.ChangeCast({
              chatId: sibling.id,
              slotId: null,
              change: { _tag: "Join", entityId: card.entityId }
            })
            yield* api.ChangeCast({
              chatId: sibling.id,
              slotId: null,
              change: { _tag: "Join", entityId: card2.entityId }
            })
            yield* api.SendMessage({
              chatId: sibling.id,
              parentSlotId: null,
              branch: false,
              content: "Another synthetic scene.",
              reply: false
            })
            return { card, persona, snippet, note, chat, chatNote, connection, entry: sent.entry }
          })
        )
        const summary = await level1(server().dataDir, fixtures.chat.id, [fixtures.entry], "Synthetic summary.")
        const measurements: unknown[] = []
        const capture = async (name: string) => {
          const header = page.locator("[data-center-header]").filter({ visible: true }).last()
          await expect(header).toBeVisible()
          await expect(header).not.toHaveText("")
          const bottoms = await header.evaluate((el) => {
            const side = document.querySelector("aside .h-shell-header")
            const tabs = document.querySelector('[role=tablist][aria-label="Chat panel"]')?.closest(".h-shell-header")
            return {
              center: el.getBoundingClientRect().bottom,
              height: el.getBoundingClientRect().height,
              side: side?.getBoundingClientRect().bottom ?? null,
              panel: tabs?.getBoundingClientRect().bottom ?? null
            }
          })
          if (width === 1440 && bottoms.side !== null) expect(bottoms.center).toBe(bottoms.side)
          if (width === 1440 && bottoms.panel !== null) expect(bottoms.center).toBe(bottoms.panel)
          measurements.push({ name, width, ...bottoms })
          await page.mouse.move(0, 899)
          await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) })
          if (process.env.LAYOUT_AUDIT) await expectLayout(page, info, name, { scope: "[data-center-header]" })
        }
        const go = async (path: string, name: string) => {
          await page.goto(`${server().url}${path}`)
          await expect(page.getByRole("status").filter({ hasText: /^(Loading|Opening)/ })).toHaveCount(0)
          await capture(name)
        }
        for (const [path, name] of [
          ["/", "home"],
          ["/library", "library"],
          ["/chats", "chats"],
          ["/import", "import"],
          ["/import/st", "import-st"],
          ["/bin", "bin"],
          ["/settings", "settings"],
          ["/settings/account", "account"],
          [`/settings/connections/${fixtures.connection.id}`, "connection-detail"],
          ["/settings/connections", "connections"],
          ["/settings/connections/new", "new-connection"],
          ["/settings/chats", "chat-settings"],
          ["/settings/keys", "keys"],
          ["/settings/network", "network"],
          ["/settings/regex", "regex"],
          ["/settings/costs", "costs"],
          ["/settings/users", "users"],
          ["/settings/status", "status"],
          [`/cards/${fixtures.card.entityId}`, "card-chats"],
          [`/groups/${fixtures.chat.id}`, "group-chats"],
          [`/cards/${fixtures.card.entityId}/chat`, "pending-card-chat"],
          [`/groups/${fixtures.chat.id}/new`, "pending-group-chat"],
          [`/chats/${fixtures.chat.id}/context/${fixtures.entry.version.id}`, "request"],
          [`/chats/${fixtures.chat.id}/summaries/${summary.id}/request`, "summary-request"],
          [`/library/${fixtures.card.id}`, "card"],
          [`/library/${fixtures.persona.id}`, "persona"],
          [`/library/${fixtures.snippet.ref.id}?focus=snippet`, "snippet"],
          [`/library/${fixtures.note.id}`, "note"]
        ])
          await go(path!, name!)
        // Switch with an uncommitted field: leaving must keep the draft without creating a revision.
        for (const [kind, first, second, label] of [
          ["preset", presetA.id, presetB.id, `Preset B ${width}`],
          ["lorebook", bookA, bookB, `Book B ${width}`]
        ] as const) {
          await go(`/library/${first}`, kind)
          const box = page
            .getByRole("textbox", { name: kind === "preset" ? "Prompt: Main Prompt" : "Entry content", exact: true })
            .first()
          const reveal = async () => {
            if (!(await box.isVisible()))
              await page
                .getByRole("button", { name: kind === "preset" ? "Open Main Prompt" : "Open Harbor", exact: true })
                .click()
            await expect(box).toBeVisible()
          }
          await reveal()
          // The exported draft protocol is checked after an immediate selector transition.
          const before = await admin((api) => api.OpenEditor({ refId: first }))
          await box.fill(`Unsaved ${kind} ${width}`)
          const draftText = await textBoxValue(box)
          expect(draftText).toContain(`Unsaved ${kind} ${width}`)
          await page.getByRole("combobox", { name: `Switch ${kind}`, exact: true }).click()
          await page.getByRole("option", { name: label, exact: true }).click()
          await expect(page).toHaveURL(new RegExp(second))
          await page.getByRole("combobox", { name: `Switch ${kind}`, exact: true }).click()
          await page
            .getByRole("option", { name: kind === "preset" ? `Preset A ${width}` : `Book A ${width}`, exact: true })
            .click()
          await expect(page).toHaveURL(new RegExp(first))
          await reveal()
          await expectTextBox(box, draftText)
          const after = await admin((api) => api.OpenEditor({ refId: first }))
          expect(after.ref.headRevisionId).toBe(before.ref.headRevisionId)
          expect(after.drafts.some((draft) => draft.content === draftText)).toBe(true)
          await capture(`${kind}-switched-back`)
        }
        await go(`/chats/${fixtures.chat.id}`, "chat")
        if (width === 1440) {
          await openPanel(page, "Prompt preset")
          await capture("chat-panel")
        }
        for (const [ref, focus, name] of [
          [bookA, "", "lorebook-overlay"],
          [fixtures.card.id, "", "card-overlay"],
          [fixtures.persona.id, "", "persona-overlay"],
          [fixtures.snippet.ref.id, "snippet", "snippet-overlay"],
          [fixtures.chatNote.id, "note", "note-overlay"]
        ]) {
          await go(`/chats/${fixtures.chat.id}?editor=${ref}&focus=${focus}`, name!)
        }
        await page.goto(`${server().url}/chats/${fixtures.chat.id}?editor=${presetA.id}`)
        await expect(page.getByRole("combobox", { name: "Switch preset" })).toBeVisible()
        await capture("preset-overlay")
        await page.getByRole("combobox", { name: "Switch preset" }).click()
        await page.getByRole("option", { name: `Preset B ${width}`, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`editor=${presetB.id}`))
        await expect(page.getByRole("dialog", { name: "Preset editor" })).toBeVisible()
        const folder = process.env.LAYOUT_AUDIT_WORK ?? info.outputDir
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, `header-bottoms-${width}.json`), JSON.stringify(measurements, null, 2))
      })
  })
}
