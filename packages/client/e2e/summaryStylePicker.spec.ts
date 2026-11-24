// "Written as" with a registered custom summary style (FAKE_SUMMARY_STYLE: `synthetic/notes`,
// named "Story notes") as the account default: the picker shows it as the selected option in
// Settings → Chats and in a chat that follows the default, names it as what Reset goes back to,
// and keeps its width while choices change.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"
import { type Client, loginCookie, withCookie } from "./support/rpc.ts"
import { openSummarySettings } from "./support/panel.ts"

const server = serverPerFile({ ...withAdmin, FAKE_SUMMARY_STYLE: "on" })
test.describe.configure({ mode: "serial" })
test.setTimeout(120_000)
let cookie = ""
const admin = <A>(use: (api: Client) => Effect.Effect<A, unknown>) => withCookie(server(), cookie, use)

test.beforeAll(async () => {
  cookie = await loginCookie(server(), ADMIN.handle, ADMIN.password)
})

const open = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: "dark" })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
}

const shoot = async (target: Locator, name: string) => {
  const dir = process.env.SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await target.screenshot({ path: join(dir, `${name}.png`) })
}

/** The field, with its legend, the row of choices and where the value comes from. */
const field = (scope: Locator) => scope.getByRole("group", { name: "Written as" }).first()
const writtenAs = (scope: Locator) => scope.getByRole("group", { name: "Written as" }).last()
const segment = (scope: Locator, name: string) => writtenAs(scope).getByRole("button", { name, exact: true })
const pressed = (scope: Locator, name: string) => expect(segment(scope, name)).toHaveAttribute("aria-pressed", "true")
const width = async (scope: Locator) => (await writtenAs(scope).boundingBox())!.width

for (const viewport of [1340, 390])
  test(`a registered custom account default shows as the chosen style at ${viewport}`, async ({ page }) => {
    await admin((api) => api.ChangeGenerationDefaults({ change: { lcm: { style: "synthetic/notes" } } }))
    await open(page, viewport)
    await page.goto(`${server().url}/settings/chats`)
    const defaults = page.getByRole("region", { name: "Summary defaults for new chats" })
    await pressed(defaults, "Story notes")
    await expect(segment(defaults, "A reply")).toHaveAttribute("aria-pressed", "false")
    await expect(defaults).toContainText("Your default; the built-in is a reply.")
    await shoot(field(defaults), `account-custom-${viewport}-dark`)
    // Choosing a built-in keeps the row as it was: the custom style stays there to go back to.
    const before = await width(defaults)
    await segment(defaults, "A reply").click()
    await pressed(defaults, "A reply")
    expect(await width(defaults)).toBe(before)
    await segment(defaults, "Story notes").click()
    await pressed(defaults, "Story notes")

    // A chat with its own built-in style names the account default, and Reset goes back to it.
    const made = await admin((api) => api.CreateChat({ title: `Story notes ${viewport}` }))
    await admin((api) => api.ChangeLcmSettings({ chatId: made.id, change: { style: "tool" } }))
    await page.goto(`${server().url}/chats/${made.id}`)
    const section = await openSummarySettings(page)
    await pressed(section, "With tools")
    await expect(section).toContainText("This chat's own; the account default is Story notes.")
    const chatBefore = await width(section)
    await field(section).getByRole("button", { name: "Reset to account default", exact: true }).click()
    await pressed(section, "Story notes")
    await expect(section).toContainText("Follows the account default.")
    expect(await width(section)).toBe(chatBefore)
    await shoot(field(section), `chat-follows-custom-${viewport}-dark`)
    // The hover is the style's own description.
    if (viewport === 1340) {
      await segment(section, "Story notes").hover()
      await expect(page.locator('[data-layout-overlay="Tooltip floats above the page"]')).toContainText(
        "Writes the summary as short story notes."
      )
    }
  })

test("with built-in defaults the picker keeps its two choices", async ({ page }) => {
  await admin((api) => api.ChangeGenerationDefaults({ change: { lcm: { style: null } } }))
  await open(page, 1340)
  await page.goto(`${server().url}/settings/chats`)
  const defaults = page.getByRole("region", { name: "Summary defaults for new chats" })
  await pressed(defaults, "A reply")
  await expect(writtenAs(defaults).getByRole("button")).toHaveCount(2)
})
