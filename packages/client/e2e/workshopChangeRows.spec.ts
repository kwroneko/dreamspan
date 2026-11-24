// A workshop's change rows and change view in the browser (spec/WORKSHOP-CARDS.md §7, unit C8):
// a scripted reply edits one card and makes another; under the turn's last message a row per item
// names it (opening the card as it is now) and counts its change (opening the change view). Wide,
// with the card open beside the workshop, both open in the card's frame and the workshop keeps
// its own; on a phone they open in place. The change view shows only the fields that differ, each
// with Revert this field and Redo; a Revert that conflicts shows the field now and before with Keep
// now / Take before (§8.1); the row's Redo takes a revert back, and a made card changed since asks
// before the bin. Synthetic cards and a scripted loopback provider only.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { asUser, type Client } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { startWorkshopProvider } from "./support/workshopProvider.ts"

const shots = process.env.SCREENSHOT_DIR
const ANSWER = "I tightened Mara and made Ove to go with her."
const OVE_DESCRIPTION = "A synthetic ferryman who owes Mara a favour."
/** The card the latest task names: "Work on <name>." */
const named = (body: { messages: ReadonlyArray<{ role: string; content?: unknown }> }) =>
  [...JSON.stringify(body.messages).matchAll(/Work on (Mara \d+ [a-z]+)\./g)].at(-1)?.[1] ?? ""

test.describe("workshop change rows", () => {
  const server = serverPerFile(withAdmin)
  let provider: Awaited<ReturnType<typeof startWorkshopProvider>>
  const admin = <A>(use: (client: Client) => Effect.Effect<A, unknown>) =>
    asUser(server(), ADMIN.handle, ADMIN.password, use)
  test.beforeAll(async () => {
    provider = await startWorkshopProvider({
      perTask: true,
      answer: ANSWER,
      calls: [
        {
          name: "edit_card",
          arguments: (body) => ({
            card: named(body),
            changes: [
              { field: "description", text: "A synthetic keeper who logs every ship by lamplight." },
              { field: "scenario", text: "The fog came in early tonight." }
            ]
          })
        },
        {
          name: "create_card",
          arguments: (body) => ({
            name: `Ove for ${named(body)}`,
            description: OVE_DESCRIPTION
          })
        },
        {
          name: "read_card",
          arguments: (body) => ({ card: `Ove for ${named(body)}`, fields: ["description"] })
        }
      ]
    })
    await admin((api) =>
      Effect.gen(function* () {
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Synthetic workshop",
            baseUrl: provider.baseUrl,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: "workshop-small", overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { model: { connection: connection.id, model: model.id }, preset: null }
        })
      })
    )
  })
  test.afterAll(async () => {
    await provider.stop()
  })

  /** A user's own save of one text field. */
  const userEdit = (refId: RefId, key: string, content: string) =>
    admin((api) =>
      Effect.gen(function* () {
        const field = textField([key])
        const before = yield* api.OpenEditor({ refId })
        const draft = yield* api.SaveEditorDraft({
          refId,
          field,
          content,
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: before.ref.headRevisionId
        })
        yield* api.CommitEditorDrafts({
          refId,
          expectedRowVersion: before.ref.rowVersion,
          fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
      })
    )

  const importCard = async (page: Page, name: string) => {
    const data = {
      name,
      description: "A synthetic lighthouse keeper.",
      personality: "Careful.",
      scenario: "A calm night.",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "Synthetic",
      character_version: "",
      extensions: {}
    }
    const response = await page.request.post(`${server().url}/library/import?name=card.json`, {
      data: Buffer.from(JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data })),
      headers: { origin: server().url, "content-type": "application/octet-stream" }
    })
    expect(response.status()).toBe(200)
    return (await response.json()).library.ref as { id: RefId; entityId: EntityId }
  }

  for (const width of [1340, 390])
    for (const theme of ["dark", "light"] as const)
      test(`rows under the turn open the card and its changes, and Revert puts it back, at ${width} ${theme}`, async ({
        page
      }, info) => {
        test.setTimeout(180_000)
        const name = `Mara ${width} ${theme}`
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.addInitScript((value) => localStorage.setItem("dreamspan.theme", value), theme)
        await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
        const card = await importCard(page, name)
        const shot = async (label: string) => {
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          if (!shots) return
          mkdirSync(shots, { recursive: true })
          await page.waitForTimeout(200)
          await page.screenshot({ path: resolve(shots, `change-rows-${label}-${width}-${theme}.png`) })
        }

        await page.goto(`${server().url}/library`)
        await page.getByRole("button", { name: `More actions for ${name}`, exact: true }).click()
        await page.getByRole("menuitem", { name: "Work on in a workshop" }).click()
        await page
          .getByRole("menu", { name: "Work on in a workshop" })
          .getByRole("menuitem", { name: "A new workshop" })
          .click()
        const tile = `[data-library-tile="${card.id}"]`
        await expect(page.getByLabel("Attachments", { exact: true }).locator(tile)).toBeVisible()
        await expect(page).not.toHaveURL(/workshopAttach=/)
        await page.getByLabel("Message", { exact: true }).fill(`Work on ${name}.`)
        await page.getByRole("button", { name: /^Send( as .+)?$/ }).click()
        const task = page.getByRole("article").filter({ hasText: `Work on ${name}.` })
        await expect(task.getByLabel("Attached from your library").locator(tile)).toBeVisible()
        await expect(page.getByRole("article").filter({ hasText: ANSWER })).toHaveCount(1, { timeout: 30_000 })
        expect(provider.toolResults().at(-1)).toContain(OVE_DESCRIPTION)

        // One row per item, in the order the turn changed them, under the turn's last message.
        const rows = page.locator("[data-change-rows]")
        await expect(rows).toHaveCount(1)
        const mara = rows.locator(`[data-change-row="${card.id}"]`)
        await expect(rows.locator("[data-change-row]")).toHaveCount(2)
        await expect(mara.locator("[data-change-name]")).toHaveText(name)
        await expect(mara.locator("[data-change-count]")).toHaveText("Edited · 2 fields")
        const ove = rows.locator("[data-change-row]").nth(1)
        await expect(ove.locator("[data-change-name]")).toHaveText(`Ove for ${name}`)
        await expect(ove.locator("[data-change-count]")).toHaveText(/^New card · \d+ fields?$/)
        await expect(mara.locator("[data-change-action]")).toHaveText("Revert")
        await expect(ove.locator("[data-change-action]")).toHaveText("Undo")
        // Each link and action says what it does.
        const tip = page.locator('[data-layout-overlay="Tooltip floats above the page"][data-open]')
        await mara.locator("[data-change-count]").hover()
        await expect(tip).toHaveText("Shows what the assistant changed: Description, Scenario.")
        await mara.locator("[data-change-name]").hover()
        await expect(tip).toHaveText(`Opens ${name} as it is now.`)
        await page.mouse.move(0, 0)
        await shot("rows")
        await expectLayout(page, info, `change-rows-${width}-${theme}`, { scope: "[data-change-rows]" })

        const frames = page.locator("[data-frame]")
        if (width === 1340) {
          // The card beside the workshop (Alt-click), then a plain click on the count: the change
          // view opens in the card's frame, and the workshop keeps its own.
          await mara.locator("[data-change-name]").click({ modifiers: ["Alt"] })
          await expect(frames).toHaveCount(2)
          const cardFrame = frames.nth(1)
          await expect(cardFrame.locator("[data-tab]")).toHaveCount(1)
          await frames.first().locator(`[data-change-row="${card.id}"] [data-change-count]`).click()
          await expect(cardFrame.getByRole("heading", { name: `${name} · changes` })).toBeVisible()
          await expect(cardFrame.locator("[data-tab]")).toHaveCount(2)
          await expect(frames.first().locator("[data-tab]")).toHaveCount(1)
          await expect(frames.first().locator("[data-change-rows]")).toBeVisible()
        } else {
          await mara.locator("[data-change-count]").click()
          await expect(page.getByRole("heading", { name: `${name} · changes` })).toBeVisible()
          await expect(frames).toHaveCount(1)
        }
        await expect(page).toHaveURL(new RegExp(`/library/${card.id}/change\\?`))
        const view = page.locator("section", { has: page.getByRole("heading", { name: `${name} · changes` }) }).last()
        const changed = view.getByLabel("What changed", { exact: true }).locator("details")
        await expect(changed).toHaveCount(2)
        await expect(changed.locator("summary")).toHaveText([/^Description/, /^Scenario/])
        await changed.first().locator("summary").click()
        await expect(view.getByText("logs every ship by lamplight")).toBeVisible()
        await expect(view.getByText(/Changed by the assistant in a workshop reply/)).toBeVisible()
        await shot("view")
        await expectLayout(page, info, `change-view-${width}-${theme}`, { scope: "main" })

        // One field reverted from its line, then put back with Redo (spec/WORKSHOP-CARDS.md §7.4).
        const scenario = changed.nth(1)
        await scenario.locator("[data-field-revert]").hover()
        await expect(tip).toHaveText("Puts this field back as it was before this change, as a new revision.")
        await scenario.locator("[data-field-revert]").click()
        await expect(scenario.locator("[data-field-reverted]")).toHaveText("Reverted", { timeout: 15_000 })
        let doc = await admin((api) => api.OpenEditor({ refId: card.id }))
        expect(doc.doc.scenario).toBe("A calm night.")
        expect(doc.doc.description).toBe("A synthetic keeper who logs every ship by lamplight.")
        await page.mouse.move(0, 0)
        await shot("field-reverted")
        await scenario.locator("[data-field-redo]").click()
        await expect(scenario.locator("[data-field-revert]")).toBeVisible({ timeout: 15_000 })
        doc = await admin((api) => api.OpenEditor({ refId: card.id }))
        expect(doc.doc.scenario).toBe("The fog came in early tonight.")

        // The user changes the same words since: Revert writes nothing and shows the conflict,
        // now and before; Take before, then Revert the rest.
        await userEdit(card.id, "description", "A synthetic keeper who logs every gull by moonlight.")
        await view.locator("[data-change-action]").click()
        const conflicts = view.locator("[data-change-conflicts]")
        await expect(conflicts).toBeVisible({ timeout: 15_000 })
        await expect(conflicts.locator("[data-conflict]")).toHaveCount(1)
        await expect(conflicts.getByText("every gull by moonlight")).toBeVisible()
        doc = await admin((api) => api.OpenEditor({ refId: card.id }))
        expect(doc.doc.description).toBe("A synthetic keeper who logs every gull by moonlight.")
        await shot("conflict")
        await expectLayout(page, info, `change-conflict-${width}-${theme}`, { scope: "main" })
        await conflicts.getByRole("button", { name: "Take before" }).click()
        await conflicts.locator("[data-revert-rest]").click()
        await expect(view.locator("[data-change-state]")).toHaveText("Reverted", { timeout: 15_000 })
        await expect(conflicts).toHaveCount(0)
        doc = await admin((api) => api.OpenEditor({ refId: card.id }))
        expect(doc.doc.description).toBe("A synthetic lighthouse keeper.")
        expect(doc.doc.scenario).toBe("A calm night.")
        if (width === 390) await page.goBack()
        const row = page.locator(`[data-change-row="${card.id}"]`).first()
        await expect(row.locator("[data-change-state]")).toHaveText("Reverted")
        await shot("reverted")

        // Redo on the row takes the revert back: the description as it was before the revert.
        await row.locator("[data-change-redo]").click()
        await expect(row.locator("[data-change-action]")).toHaveText("Revert", { timeout: 15_000 })
        doc = await admin((api) => api.OpenEditor({ refId: card.id }))
        expect(doc.doc.description).toBe("A synthetic keeper who logs every gull by moonlight.")
        expect(doc.doc.scenario).toBe("The fog came in early tonight.")

        // A made card changed since asks before it goes to the bin.
        const oveRow = page.locator("[data-change-rows] [data-change-row]").nth(1)
        const oveRef = (await oveRow.locator("[data-change-name]").getAttribute("href"))!.split("/").at(-1)!
        await userEdit(decodeURIComponent(oveRef) as RefId, "description", "Changed by hand.")
        await oveRow.locator("[data-change-action]").click()
        const dialog = page.getByRole("alertdialog")
        await expect(dialog).toContainText(`Ove for ${name} was changed since.`)
        await shot("ask")
        await dialog.getByRole("button", { name: "Move to the bin" }).click()
        await expect(oveRow.locator("[data-change-state]")).toHaveText("Undone", { timeout: 15_000 })
      })
})
