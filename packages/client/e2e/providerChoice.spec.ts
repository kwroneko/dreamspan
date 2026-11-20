// A new connection starts from its provider (providerchoice): the provider first, then the fields
// that provider needs (a Region and an AWS access key for Bedrock, an address for a custom
// server), and an advanced section with the provider's own defaults. Help on hover, no internals
// in the copy, and the layout audit at 1440 and 390 px in light and dark. Nothing reaches a
// provider: a Bedrock connection lists its models from the catalog.
import { chooseDefaultModelIfNone } from "./support/provider.ts"
import { expect, test, type Page } from "@playwright/test"
import { expectLayout } from "./support/layoutAudit.ts"
import { ADMIN, apiLogin, serverPerFile, withAdmin } from "./support/server.ts"

const server = serverPerFile(withAdmin)
test.describe.configure({ mode: "serial" })

const PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "Anthropic (AWS Bedrock)",
  "Anthropic (Google Vertex)",
  "OpenAI (AWS Bedrock)",
  "OpenRouter",
  "DeepSeek",
  "Google AI Studio",
  "OpenAI-compatible (custom)"
]

const picker = (page: Page, name: string) => page.getByRole("combobox", { name, exact: true })

/** An open picker's option by its label alone: on a phone its explanation shows under the label. */
const option = (page: Page, label: string) =>
  page.getByRole("option").filter({ has: page.getByText(label, { exact: true }) })

const choose = async (page: Page, name: string, label: string) => {
  await picker(page, name).click()
  await option(page, label).click()
  await expect(picker(page, name)).toContainText(label)
}

/** Hovers a "?": its help shows beside it, and is its description for screen readers. */
const help = async (page: Page, name: string, text: RegExp) => {
  const hint = page
    .getByRole("button", { name: `About ${name}`, exact: true })
    .filter({ visible: true })
    .first()
  await hint.scrollIntoViewIfNeeded()
  await hint.hover()
  await expect(hint).toHaveAccessibleDescription(text)
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible()
  await page.mouse.move(0, 0)
}

const noInternals = async (page: Page) => {
  const shown = await page.locator("main").innerText()
  expect(shown).not.toMatch(/\bshims?\b|payload|sigv4|prompt_cache_key|lookback|breakpoints?\b|anthropic_beta/i)
}

// Before any draft: OpenAI with Chat Completions, listed first (DESIGN §9, owner 2026-10-10).
test("a new connection starts on OpenAI with Chat Completions", async ({ page }) => {
  await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
  await page.goto(`${server().url}/settings/connections/new`)
  await expect(picker(page, "Provider")).toContainText("OpenAI")
  await expect(picker(page, "Provider")).not.toContainText("compatible")
  await expect(picker(page, "API type")).toContainText("Chat Completions")
  await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute("placeholder", "https://api.openai.com/v1")
})

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`provider first, then what it needs: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/connections/new`)

      // The provider is the first field, and lists every built-in provider in order. (The form
      // keeps an unsent draft, so the selection here is the previous test's.)
      const first = page.locator("main form").getByRole("combobox").first()
      await expect(first).toHaveAccessibleName("Provider")
      await help(page, "Provider", /Who serves the models/)
      await first.click()
      for (const [index, label] of PROVIDERS.entries()) {
        await expect(option(page, label)).toBeVisible()
        await expect(page.getByRole("option").nth(index)).toContainText(label)
      }
      await page.keyboard.press("Escape")

      // A custom server has no default address: one must be entered.
      await choose(page, "Provider", "OpenAI-compatible (custom)")
      await expect(picker(page, "API type")).toBeVisible()
      await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute(
        "placeholder",
        "http://localhost:8000/v1"
      )
      await chooseDefaultModelIfNone(page)
      await page.getByRole("button", { name: "Create connection" }).click()
      await expect(page.getByText("Enter the server’s address, such as http://localhost:8000/v1.")).toBeVisible()

      // Bedrock: a Region that sets the address, and a choice of key.
      await choose(page, "Provider", "Anthropic (AWS Bedrock)")
      await expect(picker(page, "API type")).toHaveCount(0)
      const region = page.getByLabel("Region", { exact: true })
      await help(page, "Region", /AWS Region your models run in/)
      await region.fill("eu-west-3")
      await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute(
        "placeholder",
        "https://bedrock-runtime.eu-west-3.amazonaws.com"
      )
      await help(page, "Key type", /kind of key you have/)
      await choose(page, "Key type", "AWS access key")
      await expect(page.getByLabel("Access key ID", { exact: true })).toBeVisible()
      await expect(page.getByLabel("Secret access key", { exact: true })).toHaveAttribute("type", /password|text/)
      await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0)

      // The advanced section: Bedrock's own caching defaults, and how it counts.
      await page.getByText("Advanced", { exact: true }).click()
      await expect(picker(page, "Cache markers")).toContainText("Each section")
      await expect(page.getByRole("switch", { name: "Finds earlier cached parts" })).not.toBeChecked()
      await help(page, "Finds earlier cached parts", /only at a marker the last request also had/)
      // An empty minimum size is each model's own: the short placeholder fits, the help explains.
      const minSize = page.getByLabel("Smallest cached size (tokens)", { exact: true })
      await expect(minSize).toHaveAttribute("placeholder", "By model")
      expect(
        await minSize.evaluate((input: HTMLInputElement) => {
          const style = getComputedStyle(input)
          const context = document.createElement("canvas").getContext("2d")
          if (!context) return false
          context.font = style.font
          const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          return context.measureText(input.placeholder).width <= room
        })
      ).toBe(true)
      await help(page, "Smallest cached size (tokens)", /Empty uses each model’s documented size/)
      await expect(page.getByText("How tokens are counted", { exact: true })).toBeVisible()
      await expect(page.getByText("Fixes for some models", { exact: true })).toBeVisible()
      await expect(page.getByText(/Claude Haiku 5: Top P isn’t sent/)).toBeVisible()
      await noInternals(page)
      await page.getByLabel("Access key ID", { exact: true }).scrollIntoViewIfNeeded()
      await expectLayout(page, info, `provider-choice-${width}-${theme}`, { scope: "main" })
      await page.getByText("How tokens are counted", { exact: true }).scrollIntoViewIfNeeded()
      await expectLayout(page, info, `provider-choice-advanced-${width}-${theme}`, { scope: "main" })

      // A change to a default is kept apart, and can be undone.
      await page.getByRole("switch", { name: "Finds earlier cached parts" }).click()
      await expect(page.getByRole("button", { name: "Use the defaults" })).toBeVisible()
      await page.getByRole("button", { name: "Use the defaults" }).click()
      await expect(page.getByRole("switch", { name: "Finds earlier cached parts" })).not.toBeChecked()
      await expect(page.getByLabel("Region", { exact: true })).toHaveValue("eu-west-3")
      if (width !== 1440 || theme !== "light") return

      // Created: the connection names its provider and the Region's address, and its key dialog
      // asks for an access key again.
      await page.getByLabel("Name", { exact: true }).fill("Bedrock Paris")
      await page.getByLabel("Access key ID", { exact: true }).fill("AKIDEXAMPLESYNTHETIC")
      await page.getByLabel("Secret access key", { exact: true }).fill("synthetic/secret/never-used-0001")
      await chooseDefaultModelIfNone(page)
      await page.getByRole("button", { name: "Create connection" }).click()
      await expect(page.getByRole("heading", { name: "Bedrock Paris", level: 1 })).toBeVisible()
      await expect(
        page.getByText("Anthropic (AWS Bedrock) · https://bedrock-runtime.eu-west-3.amazonaws.com")
      ).toBeVisible()
      await expect(page.getByLabel("Region", { exact: true })).toHaveValue("eu-west-3")
      await expect(picker(page, "Key type")).toContainText("AWS access key")
      await page.getByRole("button", { name: "Enter a new key" }).click()
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByLabel("Access key ID", { exact: true })).toBeVisible()
      await expect(dialog.getByLabel("Secret access key", { exact: true })).toBeVisible()
      await dialog.getByRole("button", { name: "Cancel" }).click()
      await page.getByText("Advanced", { exact: true }).click()
      await expect(picker(page, "Cache markers")).toContainText("Each section")
      await expect(page.getByText("synthetic/secret")).toHaveCount(0)
      await expectLayout(page, info, `provider-connection-${width}-${theme}`, { scope: "main" })
    })

/** A synthetic service account key file: never a real key, and never sent anywhere here. */
const keyFile = {
  name: "lantern-key.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      type: "service_account",
      project_id: "lantern-project-123",
      private_key_id: "0123456789abcdef0123456789abcdef0123wxyz",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIsyntheticsyntheticsynthetic\n-----END PRIVATE KEY-----\n",
      client_email: "mira@lantern-project-123.iam.gserviceaccount.com"
    })
  )
}

for (const [width, height] of [
  [1440, 900],
  [390, 844]
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`OpenAI on Bedrock and Claude on Vertex: ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await apiLogin(page.request, server(), ADMIN.handle, ADMIN.password)
      await page.goto(`${server().url}/settings/connections/new`)

      // OpenAI on Bedrock: Responses first, the Region sets Bedrock's OpenAI address.
      await choose(page, "Provider", "OpenAI (AWS Bedrock)")
      await expect(picker(page, "API type")).toContainText("Responses")
      await page.getByLabel("Region", { exact: true }).fill("us-west-2")
      await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute(
        "placeholder",
        "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1"
      )
      await expect(picker(page, "Key type")).toBeVisible()
      await page.getByText("Advanced", { exact: true }).click()
      await expect(page.getByRole("switch", { name: "Finds earlier cached parts" })).not.toBeChecked()
      await noInternals(page)
      await page.getByText("Advanced", { exact: true }).click()

      // Claude on Vertex: a Region (global by default), a project, and a key file.
      await choose(page, "Provider", "Anthropic (Google Vertex)")
      await expect(picker(page, "API type")).toHaveCount(0)
      await expect(picker(page, "Key type")).toHaveCount(0)
      const region = page.getByLabel("Region", { exact: true })
      await expect(region).toHaveAttribute("placeholder", "global")
      await help(page, "Region", /Where Google Cloud runs your requests/)
      await region.fill("not a region")
      await chooseDefaultModelIfNone(page)
      await page.getByRole("button", { name: "Create connection" }).click()
      await expect(page.getByText("Enter a region code, such as us-east5.")).toBeVisible()
      await region.fill("us-east5")
      await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute(
        "placeholder",
        "https://us-east5-aiplatform.googleapis.com"
      )
      await region.fill("eu")
      await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute(
        "placeholder",
        "https://aiplatform.eu.rep.googleapis.com"
      )
      await help(page, "Project", /Google Cloud project ID/)
      await help(page, "Service account key", /JSON key file/)
      const file = page.getByLabel("Service account key", { exact: true })
      await file.setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("{}") })
      await expect(page.getByText("This file isn’t a service account’s JSON key.")).toBeVisible()
      await file.setInputFiles(keyFile)
      await expect(page.getByText(/Loaded: mira@lantern-project-123\.iam\.gserviceaccount\.com/)).toBeVisible()
      await expect(page.getByLabel("Project", { exact: true })).toHaveAttribute("placeholder", "lantern-project-123")
      await expect(page.getByText("MIIsynthetic")).toHaveCount(0)
      await page.getByText("Advanced", { exact: true }).click()
      await expect(picker(page, "Cache markers")).toBeVisible()
      await expect(page.getByRole("switch", { name: "Finds earlier cached parts" })).toBeChecked()
      await noInternals(page)
      await file.scrollIntoViewIfNeeded()
      await expectLayout(page, info, `provider-vertex-${width}-${theme}`, { scope: "main" })
      await page.getByText("How tokens are counted", { exact: true }).scrollIntoViewIfNeeded()
      await expectLayout(page, info, `provider-vertex-advanced-${width}-${theme}`, { scope: "main" })
      if (width !== 1440 || theme !== "light") return

      // Created: its Region and project are kept, and a new key is another file.
      await page.getByLabel("Name", { exact: true }).fill("Vertex Lantern")
      await chooseDefaultModelIfNone(page)
      await page.getByRole("button", { name: "Create connection" }).click()
      await expect(page.getByRole("heading", { name: "Vertex Lantern", level: 1 })).toBeVisible()
      await expect(page.getByText("Anthropic (Google Vertex) · https://aiplatform.eu.rep.googleapis.com")).toBeVisible()
      await expect(page.getByLabel("Region", { exact: true })).toHaveValue("eu")
      await expect(page.getByLabel("Project", { exact: true })).toBeVisible()
      await expect(page.getByText(/wxyz/).first()).toBeVisible()
      await page.getByRole("button", { name: "Enter a new key" }).click()
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByLabel("Service account key", { exact: true })).toBeVisible()
      await dialog.getByRole("button", { name: "Cancel" }).click()
      await expect(page.getByText("MIIsynthetic")).toHaveCount(0)
      await expectLayout(page, info, `provider-vertex-connection-${width}-${theme}`, { scope: "main" })
    })
