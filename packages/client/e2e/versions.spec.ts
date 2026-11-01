// Versions on every message and the version picker (DESIGN §3.1), against a server with the
// fake generator: a message the user wrote gets a model-written version from its menu, then
// its › and the arrows like a reply; the picker stars and hides versions (hidden ones
// leave the arrows), filters to the starred and compares two; "Regenerate with…" another
// model labels the new version with it. On a phone the picker is a sheet.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Effect } from "effect"
import { messageMenu, showActions } from "./support/message.ts"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile({ ...withAdmin, FAKE_GENERATOR_TPS: "400", FAKE_GENERATOR_TOKENS: "40" })

const generating = (page: Page) => page.getByText("generating", { exact: true })
const settled = (page: Page) => expect(generating(page)).toHaveCount(0, { timeout: 20_000 })
const versions = (message: Locator) => message.getByRole("group", { name: "Versions", exact: true })

const newChat = async (page: Page, title: string) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/chats`)
  await page.getByLabel("Title of the new chat").fill(title)
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible()
  await page.getByLabel("Message", { exact: true }).fill("The lantern swings.")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("article", { name: "Reply", exact: true })).toHaveCount(1)
  await settled(page)
}

/** Four versions of the reply, each generated past the last. */
const manyVersions = async (page: Page, count = 4) => {
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  for (let n = 2; n <= count; n++) {
    await reply.getByRole("button", { name: "Generate another version", exact: true }).click()
    await expect(versions(reply)).toContainText(`${n}/${n}`)
    await settled(page)
  }
  return reply
}

test("a message the user wrote gets a version from the model, then its › and arrows", async ({ page }) => {
  await newChat(page, "Harbor")
  const mine = page.getByRole("article", { name: "Your message", exact: true })
  await expect(versions(mine)).toHaveCount(0)
  await messageMenu(mine, /^Generate a version$/)
  await expect(versions(mine)).toContainText("2/2")
  await settled(page)
  // Still the user's turn, now with a model-written version shown.
  await expect(mine).toHaveAttribute("aria-label", "Your message")
  await expect(mine.getByText("generated", { exact: true })).toBeVisible()
  await showActions(mine)
  // No Regenerate in the toolbar: the › past the last version generates another.
  await expect(
    mine.getByRole("toolbar", { name: "Message actions" }).getByRole("button", { name: /Regenerate/ })
  ).toHaveCount(0)
  await versions(mine).getByRole("button", { name: "Generate another version", exact: true }).click()
  await expect(versions(mine)).toContainText("3/3")
  await versions(mine).getByRole("button", { name: "Previous version", exact: true }).click()
  await versions(mine).getByRole("button", { name: "Previous version", exact: true }).click()
  await expect(mine.locator(".markdown")).toHaveText("The lantern swings.")
  // Before the last version › steps; More actions still regenerates with a model of choice.
  await expect(versions(mine).getByRole("button", { name: "Next version", exact: true })).toBeVisible()
  await messageMenu(mine, "Regenerate with…")
  await expect(page.getByRole("dialog", { name: "Regenerate with another model" })).toBeVisible()
})

test("the picker stars and hides versions, filters to the starred, and compares two", async ({ page }) => {
  await newChat(page, "Chapel")
  const reply = await manyVersions(page, 15)
  await versions(reply)
    .getByRole("button", { name: /choose a version/ })
    .click()
  const picker = page.getByRole("dialog", { name: "Versions of message #2", exact: true })
  await expect(picker.getByRole("list", { name: "Versions", exact: true }).getByRole("listitem")).toHaveCount(15)
  await picker.getByRole("button", { name: "Star version 1", exact: true }).click()
  await picker.getByRole("button", { name: "Star version 3", exact: true }).click()
  await picker.getByRole("button", { name: "Hide version 2 from the arrows", exact: true }).click()
  await expect(picker.getByRole("list", { name: "Versions", exact: true }).getByRole("listitem")).toHaveCount(14)
  await expect(picker.getByText("Hidden 1: left out of the arrows")).toBeVisible()
  await picker.getByRole("button", { name: /^Starred 2/ }).click()
  await expect(picker.getByRole("list", { name: "Versions", exact: true }).getByRole("listitem")).toHaveCount(2)
  await picker.getByRole("button", { name: /^All 15/ }).click()

  // Compare: tick two, and they show side by side.
  await picker.getByRole("button", { name: "Compare", exact: true }).click()
  await picker.getByRole("checkbox", { name: "Compare version 1", exact: true }).click()
  await picker.getByRole("checkbox", { name: "Compare version 3", exact: true }).click()
  const compare = page.getByRole("dialog", { name: "Version 1 and version 3", exact: true })
  await expect(compare.getByRole("region", { name: "Version 1", exact: true })).toBeVisible()
  await expect(compare.getByRole("region", { name: "Version 3", exact: true })).toBeVisible()
  await compare.getByRole("button", { name: "What changed", exact: true }).click()
  await expect(compare.getByRole("textbox", { name: "Before", exact: true })).toBeVisible()
  await expect(compare.getByRole("textbox", { name: "After", exact: true })).toBeVisible()
  await compare.getByRole("button", { name: "Both texts", exact: true }).click()
  await compare.getByRole("button", { name: "Show #1", exact: true }).click()
  await expect(compare).toHaveCount(0)
  await expect(versions(reply)).toContainText("1/15")

  // The arrows skip the hidden version 2, and say so on the counter.
  await versions(reply).getByRole("button", { name: "Next version", exact: true }).click()
  await expect(versions(reply)).toContainText("3/15")
  await expect(versions(reply).getByRole("button", { name: /2 hidden|1 hidden/ })).toBeVisible()

  // Stored: a reload shows the same stars and hides.
  await page.reload()
  const again = page.getByRole("article", { name: "Reply", exact: true }).last()
  await versions(again)
    .getByRole("button", { name: /choose a version/ })
    .click()
  await expect(page.getByRole("button", { name: "Unstar version 3", exact: true })).toBeVisible()
  await page.getByText("Hidden 1: left out of the arrows").click()
  await expect(page.getByRole("button", { name: "Show version 2 in the arrows again", exact: true })).toBeVisible()
})

test("Regenerate with… another model labels the new version with it", async ({ page }) => {
  await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    Effect.gen(function* () {
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Relay",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        apiKey: "sk-synthetic"
      })
      yield* api.AddUserModel({ connectionId: connection.id, key: "prose-large", overrides: {} })
    })
  )
  await newChat(page, "Ferry")
  const reply = page.getByRole("article", { name: "Reply", exact: true }).last()
  await messageMenu(reply, "Regenerate with…")
  const dialog = page.getByRole("dialog", { name: "Regenerate with another model", exact: true })
  await dialog.getByRole("combobox").click()
  await page.getByRole("option", { name: "Relay · prose-large", exact: true }).click()
  await expect(versions(reply)).toContainText("2/2")
  const label = reply.getByText("Relay · prose-large", { exact: true })
  await expect(label).toBeVisible()
  // A narrow header gives way in the connection's name first, down to nothing: the model's
  // name stays whole, with no ellipsis, while any of the connection's shows (audit §7).
  const widths = await label.evaluate((element) => {
    const [connection, model] = [...element.children] as Array<HTMLElement>
    const natural = (part: HTMLElement) => {
      const range = document.createRange()
      range.selectNodeContents(part)
      return range.getBoundingClientRect().width
    }
    element.style.maxWidth = `${natural(model!) + 12}px`
    return {
      connection: connection!.getBoundingClientRect().width < natural(connection!),
      model: model!.getBoundingClientRect().width >= natural(model!) - 0.01
    }
  })
  expect(widths).toEqual({ connection: true, model: true })
  await settled(page)
  await versions(reply)
    .getByRole("button", { name: /choose a version/ })
    .click()
  await expect(page.getByRole("button", { name: /^Version 2, Relay · prose-large/ })).toBeVisible()
})

test("on a phone the picker is a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await newChat(page, "Pier")
  const reply = await manyVersions(page)
  await versions(reply)
    .getByRole("button", { name: /choose a version/ })
    .click()
  const sheet = page.getByRole("dialog", { name: "Versions of message #2", exact: true })
  await expect(sheet).toBeVisible()
  const box = await sheet.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(389)
  await sheet.getByRole("button", { name: /^Version 2,/ }).click()
  await expect(sheet).toHaveCount(0)
  await expect(versions(reply)).toContainText("2/4")
})

test("an open picker hears stars and hides on unselected versions from another tab", async ({ page }) => {
  await newChat(page, "Cross-tab versions")
  const reply = await manyVersions(page)
  await versions(reply)
    .getByRole("button", { name: /choose a version/ })
    .click()
  const other = await page.context().newPage()
  await other.goto(page.url())
  await versions(other.getByRole("article", { name: "Reply", exact: true }).last())
    .getByRole("button", { name: /choose a version/ })
    .click()
  await other.getByRole("button", { name: "Star version 1", exact: true }).click()
  await expect(page.getByRole("button", { name: "Unstar version 1", exact: true })).toBeVisible()
  await other.getByRole("button", { name: "Hide version 2 from the arrows", exact: true }).click()
  await expect(page.getByText("Hidden 1: left out of the arrows")).toBeVisible()
  await other.close()
})
