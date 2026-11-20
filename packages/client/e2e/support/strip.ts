// The composer's next-reply strip: chips above the box for the model, the prompt preset, the
// cache and, in a group, who replies next, each opening a popover of choices (nextReplyStrip.tsx).
import { expect, type Page } from "@playwright/test"

/** The strip itself. */
export const nextReply = (page: Page) => page.getByRole("group", { name: "Next reply", exact: true })

/** The model chip: "Model: <connection> · <key>. Change the model", or "Choose a model". */
export const modelChip = (page: Page) => nextReply(page).getByRole("button", { name: /^(Model: |Choose a model$)/ })

/** The prompt preset chip: "Prompt preset: <label>. Change the preset". */
export const presetChip = (page: Page) => nextReply(page).getByRole("button", { name: /^Prompt preset: / })

/** The cache chip, when there's anything to say about the next reply's cache. */
export const cacheChip = (page: Page) => nextReply(page).getByRole("button", { name: /^Cache[: ]/ })

/** In a group, "Next: <name>. Choose who replies next". */
export const nextChip = (page: Page) =>
  nextReply(page).getByRole("button", { name: /^Next: .*\. Choose who replies next$/ })

/** The chip's name for `name` replying next. */
export const nextName = (name: string) => `Next: ${name}. Choose who replies next`

/** The model chip's name for a model chosen. */
export const modelName = (label: string) => `Model: ${label}. Change the model`

/** The preset chip's name for a preset chosen. */
export const presetName = (label: string) => `Prompt preset: ${label}. Change the preset`

/** A strip popover's choices, by its title ("Model", "Prompt preset", "Who replies next"). */
export const choices = (page: Page, title: string) => page.getByRole("radiogroup", { name: title, exact: true })

/** Opens the model chip and its "Model settings…" footer: the side panel's Model tab. */
export const openModelSettings = async (page: Page) => {
  await modelChip(page).click()
  await page.getByRole("button", { name: "Model settings…", exact: true }).click()
}

/** Opens the Next chip and picks who replies next: a card's name for one reply, or null for Auto. */
export const pickReply = async (page: Page, name: string | null) => {
  await nextChip(page).click()
  const group = choices(page, "Who replies next")
  await (
    name === null ? group.getByRole("radio", { name: /^Auto/ }) : group.getByRole("radio", { name, exact: true })
  ).click()
  await expect(group).toHaveCount(0)
}

/**
 * The capability chip's text as a whole-string pattern, from counts of the registered workshop
 * capabilities (ListWorkshopCapabilities), so adding a capability doesn't break a spec.
 */
export const capabilityChip = (counts: { readonly can: number; readonly asks: number; readonly off?: number }) =>
  new RegExp(
    `^Can: ${counts.can}${counts.asks > 0 ? ` · Asks: ${counts.asks}` : ""}${counts.off ? ` · Off: ${counts.off}` : ""}$`
  )

/** How many of a workshop's capabilities are allowed, ask first, and off. */
export const capabilityCounts = (capabilities: ReadonlyArray<{ readonly mode: string }>) => ({
  can: capabilities.filter((c) => c.mode === "allow").length,
  asks: capabilities.filter((c) => c.mode === "ask").length,
  off: capabilities.filter((c) => c.mode === "off").length
})

const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)

/** The open model picker's connection filter: a connection's name, or "All connections". */
export const filterModels = async (page: Page, connection: string) => {
  await page.locator("[data-model-picker]").getByRole("combobox", { name: "Connection", exact: true }).click()
  await page.getByRole("option", { name: startsWith(connection) }).click()
}

/** The open model picker's sort: "Name" or "Last used". */
export const sortModels = async (page: Page, sort: "Name" | "Last used") => {
  await page.locator("[data-model-picker]").getByRole("combobox", { name: "Sort models", exact: true }).click()
  await page.getByRole("option", { name: startsWith(sort) }).click()
}
