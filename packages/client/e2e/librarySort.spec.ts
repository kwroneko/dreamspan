// The library's card sort, as the other character surfaces sort: Added among its choices, and a
// direction beside it, newest or oldest first, A to Z or Z to A. Synthetic cards only.
import { expect, type Page, test } from "@playwright/test"
import { asUser } from "./support/rpc.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
const NAMES = ["Sorting Beta", "Sorting Alpha", "Sorting Gamma"]

/** The cards' names in the order the list shows them. */
const order = async (page: Page) => {
  const texts = await page
    .getByRole("list", { name: "Cards", exact: true })
    .getByRole("link", { name: /^Sorting / })
    .allTextContents()
  return [...new Set(texts.map((text) => text.trim()).filter((text) => NAMES.includes(text)))]
}

test("the library's cards sort by when they were added, either way round, and by name either way", async ({ page }) => {
  // One after another, apart: Beta added first, Gamma last.
  for (const name of NAMES) {
    await asUser(server(), ADMIN.handle, ADMIN.password, (api) => api.CreateCard({ label: name, name }))
    await page.waitForTimeout(20)
  }
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/library`)
  await page.getByRole("combobox", { name: "Sort cards" }).click()
  await page.getByRole("option", { name: "Added" }).click()
  await expect.poll(() => order(page)).toEqual(["Sorting Gamma", "Sorting Alpha", "Sorting Beta"])
  await page.getByRole("button", { name: "Order: Newest first", exact: true }).click()
  await expect.poll(() => order(page)).toEqual(["Sorting Beta", "Sorting Alpha", "Sorting Gamma"])
  await page.getByRole("combobox", { name: "Sort cards" }).click()
  await page.getByRole("option", { name: "Name" }).click()
  // The direction stays: Z to A.
  await expect(page.getByRole("button", { name: "Order: Z to A", exact: true })).toBeVisible()
  await expect.poll(() => order(page)).toEqual(["Sorting Gamma", "Sorting Beta", "Sorting Alpha"])
  await page.getByRole("button", { name: "Order: Z to A", exact: true }).click()
  await expect.poll(() => order(page)).toEqual(["Sorting Alpha", "Sorting Beta", "Sorting Gamma"])
  // Remembered in this browser.
  await page.reload()
  await expect(page.getByRole("button", { name: "Order: A to Z", exact: true })).toBeVisible()
  await expect.poll(() => order(page)).toEqual(["Sorting Alpha", "Sorting Beta", "Sorting Gamma"])
})
