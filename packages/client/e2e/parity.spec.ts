import { mkdirSync } from "node:fs"
import { expect, test, type Locator } from "@playwright/test"
import { Effect } from "effect"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { openPanel } from "./support/panel.ts"
import { expectLayout } from "./support/layoutAudit.ts"

const server = serverPerFile(withAdmin)
const admin = <A>(use: Parameters<typeof asUser<A>>[3]) => asUser(server(), ADMIN.handle, ADMIN.password, use)
for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const)
    test(`compact editor parity ${width} ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      const upload = async (name: string, doc: unknown) => {
        const response = await page.request.post(`${server().url}/library/import?name=${name}.json`, {
          headers: { "content-type": "application/octet-stream", origin: server().url },
          data: Buffer.from(JSON.stringify(doc))
        })
        expect(response.status()).toBe(200)
        return (await response.json()).library.ref
      }
      const entries = { 0: { uid: 0, key: ["harbour"], content: "Calm waters.", comment: "Harbour" } }
      const card = await upload("Sailor", {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Sailor",
          description: "Synthetic sailor.",
          personality: "",
          scenario: "",
          first_mes: "",
          mes_example: "",
          creator_notes: "",
          system_prompt: "",
          post_history_instructions: "",
          alternate_greetings: [],
          tags: [],
          creator: "",
          character_version: "",
          extensions: {},
          character_book: {
            name: "Tides",
            entries: [
              { id: 0, keys: ["harbour"], content: "Calm waters.", enabled: true, insertion_order: 0, extensions: {} }
            ]
          }
        }
      })
      const book = await upload("Waters", { name: "Waters", entries })
      const fixture = await admin((api) =>
        Effect.gen(function* () {
          const persona = yield* api.CreateCard({ label: "Observer", name: "Observer" })
          const variant = yield* api.ForkVariant({
            refId: book.id,
            label: "Waters variant",
            subtitle: "",
            moveDrafts: false
          })
          const started = yield* api.StartChat({
            cards: [card.entityId],
            persona: persona.entityId,
            greeting: null,
            first: { _tag: "Send", content: "A synthetic harbour.", speakerEntityId: null }
          })
          yield* api.ChangeCast({
            chatId: started.chat.id,
            slotId: null,
            change: { _tag: "Lorebook", ref: book.id, active: true }
          })
          return { chat: started.chat, variant }
        })
      )
      const capture = async (surface: Locator, name: string) => {
        await surface.scrollIntoViewIfNeeded()
        const dir = process.env.PARITY_ARTIFACTS
        if (dir) {
          mkdirSync(dir, { recursive: true })
          await surface.screenshot({ path: `${dir}/${width}-${theme}-${name}.png` })
        }
        if (process.env.LAYOUT_AUDIT) {
          await surface.evaluate((el) => el.setAttribute("data-parity-audit", ""))
          await expectLayout(page, info, name, { scope: "[data-parity-audit]" })
          await surface.evaluate((el) => el.removeAttribute("data-parity-audit"))
        }
      }
      await page.goto(`${server().url}/chats/${fixture.chat.id}`)
      const lore = await openPanel(page, "Lorebooks")
      await lore.getByRole("button").filter({ hasText: book.label }).first().click()
      const editor = lore.getByRole("region", { name: `Lorebook ${book.label}`, exact: true })
      await capture(editor, "library-book")
      if (!process.env.PARITY_BEFORE) {
        await expect(editor.getByText("Added to 1 chat.", { exact: true })).toBeVisible()
        await expect(editor.getByRole("region", { name: "Where it's used" })).toContainText("1 entry")
        await expect(
          editor.getByRole("navigation", { name: "Variants" }).getByRole("link", { name: "Waters variant" })
        ).toBeVisible()
        await editor.getByRole("button", { name: "Make a variant", exact: true }).click()
        const variantDialog = page.getByRole("dialog", { name: "Make a variant", exact: true })
        await expect(variantDialog.getByRole("textbox", { name: "Library label", exact: true })).toHaveValue(
          "Waters (variant)"
        )
        await variantDialog.getByRole("button", { name: "Cancel", exact: true }).click()
        await editor.getByText("Book settings", { exact: false }).click()
        await editor.getByRole("textbox", { name: "Lorebook description", exact: true }).fill("Side-panel description")
        await capture(editor.locator("details").first(), "library-settings")
        await editor.getByRole("button", { name: "History", exact: true }).click()
        await expect(page.getByRole("dialog", { name: "History", exact: true })).toBeVisible()
        await page
          .getByRole("dialog", { name: "History", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click()
      }
      const character = await openPanel(page, "Sailor")
      await capture(character, "character")
      if (!process.env.PARITY_BEFORE) {
        const favourite = character.getByRole("button", { name: "Add Sailor to favourites", exact: true })
        await favourite.click()
        await expect(
          character.getByRole("button", { name: "Remove Sailor from favourites", exact: true })
        ).toBeVisible()
        await character.getByRole("button", { name: "Import a new version…", exact: true }).click()
        const imported = page.getByRole("dialog", { name: "Import a new version of Sailor", exact: true })
        await expect(imported).toBeVisible()
        await imported.getByRole("button", { name: "Close", exact: true }).click()
      }
      if (!process.env.PARITY_BEFORE) {
        await character.getByRole("button", { name: "Card fork actions", exact: true }).click()
        const menu = page.getByRole("menu", { name: "Card fork actions", exact: true })
        await capture(menu, "fork-actions")
        await menu.getByRole("menuitem", { name: "Fork…", exact: true }).click()
        const fork = page.getByRole("dialog", { name: "Fork card", exact: true })
        await expect(fork).toBeVisible()
        await fork.getByRole("button", { name: "Cancel", exact: true }).click()
        await character.getByRole("button", { name: "Card fork actions", exact: true }).click()
        await page.getByRole("menuitem", { name: "Forks", exact: true }).click()
        const family = page.getByRole("dialog").last()
        await expect(family).toBeVisible()
        await family.getByRole("button", { name: "Close", exact: true }).click()
      }
      await character.getByRole("tab", { name: "Lorebook", exact: true }).click()
      const own = character.getByRole("region", { name: "Lorebook Sailor's lorebook", exact: true })
      await capture(own, "own-book")
      if (!process.env.PARITY_BEFORE) {
        await own.getByText("Book settings", { exact: false }).click()
        await own.getByRole("textbox", { name: "Lorebook name", exact: true }).fill("New tides")
        await own.getByRole("textbox", { name: "Lorebook description", exact: true }).fill("Card book description")
        await capture(own.locator("details").first(), "own-settings")
        await own.getByRole("button", { name: "History", exact: true }).click()
        await expect(page.getByRole("dialog", { name: "History", exact: true })).toBeVisible()
      }
    })
