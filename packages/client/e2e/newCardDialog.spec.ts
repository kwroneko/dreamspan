// Creation and naming forms keep drafts without a detached history toolbar.
import { expect, test } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { expectLayout } from "./support/layoutAudit.ts"
import { openPanel } from "./support/panel.ts"

const server = serverPerFile(withAdmin)

for (const width of [1440, 390]) {
  test(`creation and naming controls at ${width}`, async ({ page }, info) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: 1000 })
    await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
    const seeded = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
      Effect.gen(function* () {
        const card = yield* api.CreateCard({ label: `Dialog card ${width}`, name: `Dialog card ${width}` })
        const other = yield* api.CreateCard({ label: `Other ${width}`, name: `Other ${width}` })
        const preset = yield* api.CreatePreset({ label: `Dialog preset ${width}` })
        const connection = yield* api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Dialog connection",
            baseUrl: "http://127.0.0.1:1/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        const start = () =>
          api.StartChat({
            cards: [card.entityId, other.entityId],
            persona: null,
            greeting: null,
            first: { _tag: "Send", content: "Synthetic opening.", speakerEntityId: null }
          })
        const chat = yield* start()
        yield* start()
        return { card, preset, connection, chat: chat.chat }
      })
    )
    const audit = async (name: string, dialog = true) => {
      const scope = dialog ? page.getByRole("dialog") : page.getByRole("main")
      await expect(scope).toBeVisible()
      await expect(scope.getByRole("button", { name: "Undo / history", exact: true })).toHaveCount(0)
      if (dialog) await expect(scope).toHaveAccessibleDescription("")
      if (process.env.LAYOUT_AUDIT) {
        await expectLayout(page, info, name)
        await info.attach(name, {
          body: await page.screenshot({ path: info.outputPath(name + ".png") }),
          contentType: "image/png"
        })
      }
    }
    const close = () => page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click()
    await page.goto(`${server().url}/library`)
    await page.getByRole("button", { name: "New card", exact: true }).click()
    let dialog = page.getByRole("dialog", { name: "New card", exact: true })
    await expect(
      dialog.getByText("These names are saved with the card and travel with its exported file.")
    ).toHaveCount(0)
    const version = dialog.getByRole("textbox", { name: "Version", exact: true })
    await expect(version).toBeVisible()
    await audit("new-card")
    await dialog.getByRole("button", { name: "About Version", exact: true }).hover()
    await expect(page.getByText("Shown as the card's subtitle.", { exact: true }).last()).toBeVisible()
    await version.fill(`draft-${width}`)
    await close()
    await page.reload()
    await page.getByRole("button", { name: "New card", exact: true }).click()
    await expect(version).toHaveValue(`draft-${width}`)
    await close()
    await page.getByRole("button", { name: "New prompt preset", exact: true }).click()
    await audit("new-preset")
    await close()
    for (const [ref, title] of [
      [seeded.card, "Fork card"],
      [seeded.preset, "Make a variant"]
    ] as const) {
      await page.goto(`${server().url}/library/${ref.id}`)
      await page.getByRole("button", { name: ref === seeded.card ? "Fork" : "Make a variant", exact: true }).click()
      await expect(page.getByRole("dialog", { name: title, exact: true })).toBeVisible()
      await audit(title)
      await close()
    }
    await page.goto(`${server().url}/chats/${seeded.chat.id}`)
    await page.getByRole("heading", { level: 1 }).getByRole("button").click()
    await audit("rename-chat")
    await close()
    await openPanel(page, seeded.card.label)
    await page.getByRole("button", { name: `Fork for this chat: ${seeded.card.label}`, exact: true }).click()
    await audit("fork-for-chat")
    await close()
    await page.goto(`${server().url}/groups/${seeded.chat.id}`)
    await page.getByRole("button", { name: "Rename group", exact: true }).click()
    await audit("rename-group")
    await close()
    await page.goto(`${server().url}/settings/keys`)
    await page.getByRole("button", { name: "Save a key", exact: true }).click()
    await audit("save-key")
    dialog = page.getByRole("dialog")
    await dialog.getByLabel("Name", { exact: true }).fill(`Dialog key ${width}`)
    await dialog.getByLabel("Key", { exact: true }).fill("synthetic-secret")
    await dialog.getByRole("button", { name: "Save key", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page
      .getByRole("listitem")
      .filter({ has: page.getByText(`Dialog key ${width}`, { exact: true }) })
      .getByRole("button", { name: "Rename", exact: true })
      .click()
    await audit("rename-key")
    await close()
    await page.goto(`${server().url}/settings/connections/${seeded.connection.id}`)
    await page.getByRole("button", { name: "Add a model", exact: true }).click()
    await audit("add-model")
    await close()
    await page.getByRole("button", { name: "Enter a new key", exact: true }).click()
    await audit("enter-new-key")
    await close()
    await page.goto(`${server().url}/settings/users`)
    await page.getByRole("button", { name: "New user", exact: true }).click()
    await audit("new-user")
    await close()
    await page.goto(`${server().url}/library/${seeded.card.id}`)
    await page.getByRole("button", { name: "More actions", exact: true }).click()
    await page.getByRole("button", { name: "Mark as a fork of…", exact: true }).click()
    await audit("mark-parent")
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Import a new version…", exact: true }).click()
    await audit("import-new-version")
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await page.goto(`${server().url}/settings/connections/new`)
    await audit("new-connection", false)
    await page.goto(`${server().url}/chats`)
    await audit("new-empty-chat", false)
  })
}
