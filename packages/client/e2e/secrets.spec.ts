// Secrets being typed stay in the input's live value: never in a DOM attribute (where
// page markup, extensions and serializers see them), and never after the dialog closes.
import { expect, type Locator, type Page, test } from "@playwright/test"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)

test("without CSS masking, a key field is a password field, still opted out of the managers", async ({ page }) => {
  // Stands in for a browser without -webkit-text-security.
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS) as (property: string, value: string) => boolean
    CSS.supports = ((property: string, value: string) =>
      property === "-webkit-text-security" ? false : supports(property, value)) as typeof CSS.supports
  })
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  const key = page.getByLabel("Key", { exact: true })
  await expect(key).toHaveAttribute("type", "password")
  await expect(key).toHaveAttribute("autocomplete", "off")
  await expect(key).toHaveAttribute("data-1p-ignore", "")
  await expect(key).toHaveAttribute("data-lpignore", "true")
  await expect(key).toHaveAttribute("data-bwignore", "")
})

/** The page's markup, attributes included, as anything reading the DOM would see it. */
const markup = (page: Page) => page.evaluate(() => document.documentElement.outerHTML)

/** A field for a key: plain text (password managers leave it alone), masked, opted out of the extensions. */
const expectKeyField = async (field: Locator) => {
  await expect(field).toHaveAttribute("type", "text")
  await expect(field).toHaveAttribute("autocomplete", "off")
  await expect(field).toHaveAttribute("data-1p-ignore", "")
  await expect(field).toHaveAttribute("data-lpignore", "true")
  await expect(field).toHaveAttribute("data-bwignore", "")
  expect(await field.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-text-security"))).toBe(
    "disc"
  )
}

test("keys, header values and passwords never reach an attribute, and closing a dialog forgets them", async ({
  page
}) => {
  await page.goto(`${server().url}/login`)
  await page.getByLabel("Handle").fill(ADMIN.handle)
  await page.getByLabel("Password").fill(ADMIN.password)
  expect(await markup(page)).not.toContain(ADMIN.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByTitle("Signed in as admin (admin)")).toBeVisible()

  await page.goto(`${server().url}/settings/connections/new`)
  await page.getByLabel("Name").fill("Secrets")
  await page.getByLabel("Base URL").fill("http://127.0.0.1:9/v1")
  await expectKeyField(page.getByLabel("Key", { exact: true }))
  await page.getByLabel("Key", { exact: true }).fill("sk-typed-on-the-form-0001")
  expect(await markup(page)).not.toContain("sk-typed-on-the-form")
  await page.getByRole("button", { name: "Create connection" }).click()
  await expect(page.getByRole("heading", { name: "Secrets", level: 1 })).toBeVisible()

  await page.getByRole("button", { name: "Enter a new key" }).click()
  let dialog = page.getByRole("dialog")
  await expectKeyField(dialog.getByLabel("Key"))
  await dialog.getByLabel("Key").fill("sk-typed-then-cancelled-0002")
  expect(await markup(page)).not.toContain("sk-typed-then-cancelled")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toBeHidden()
  expect(await markup(page)).not.toContain("sk-typed-then-cancelled")
  await page.getByRole("button", { name: "Enter a new key" }).click()
  await expect(page.getByRole("dialog").getByLabel("Key")).toHaveValue("")
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Add headers" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Header 1 name").fill("X-Token")
  await expectKeyField(dialog.getByLabel("Header 1 value"))
  await dialog.getByLabel("Header 1 value").fill("header-value-0003")
  expect(await markup(page)).not.toContain("header-value-0003")
  await dialog.getByRole("button", { name: "Cancel" }).click()

  await page.goto(`${server().url}/settings/keys`)
  await page.getByRole("button", { name: "Allow an address" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Address").fill("https://other.example")
  await expectKeyField(dialog.getByLabel("Key"))
  await dialog.getByLabel("Key").fill("sk-retyped-0004")
  expect(await markup(page)).not.toContain("sk-retyped")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await page.getByRole("button", { name: "Allow an address" }).click()
  await expect(page.getByRole("dialog").getByLabel("Key")).toHaveValue("")
})
