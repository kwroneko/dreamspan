// Text typed in settings, connections, files, workshops and other pages outside a chat.
import type { Locator, Page } from "@playwright/test"
import { place, type PlaceContext } from "../durability.ts"
import { filesOf } from "../files.ts"
import { chooseCustomServer } from "../provider.ts"

const go = (page: Page, { server }: PlaceContext, path: string) => page.goto(`${server.url}${path}`)

/** A connection of the user's to an address nothing answers on. */
const connection = ({ rpc, tag }: PlaceContext) =>
  rpc((api) =>
    api.CreateConnection({
      kind: "openai-chat",
      settings: {
        name: `Durable ${tag}`,
        baseUrl: "http://127.0.0.1:1/v1",
        compat: {},
        cacheTtlS: null,
        maxConcurrent: null,
        presetOverrideRefId: null
      }
    })
  )

const mcpSettings = (tag: string) => ({
  name: `Durable MCP ${tag}`,
  about: "Synthetic notes server.",
  transport: "streamable-http" as const,
  url: "http://127.0.0.1:1/mcp",
  timeoutS: 30
})

const chunkSize = (page: Page) => page.getByRole("textbox", { name: "Chunk size", exact: true })
const archiveDays = (page: Page) =>
  page.getByRole("dialog", { name: "Archive unused cards", exact: true }).getByRole("spinbutton", { name: "Days" })

const subagentNote = (page: Page) =>
  page.locator('[data-subagent-model-row="same"]').getByLabel("What it's for", { exact: true })

export const settingsPlaces = [
  place({
    name: "Settings, chats: summarization chunk size (Advanced)",
    source: "features/chat/LcmFields.tsx:115",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/chats")
      const advanced = page.getByText("Advanced", { exact: true })
      await advanced.or(chunkSize(page)).first().waitFor()
      if (!(await chunkSize(page).isVisible())) await advanced.click()
      return chunkSize(page)
    },
    shown: chunkSize
  }),
  place({
    name: "Archive unused cards: days",
    source: "features/characters/ArchiveUnused.tsx:146",
    setup: async () => null,
    numeric: true,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/?show=archived")
      await page.getByRole("button", { name: "Archive unused cards…", exact: true }).click()
      return archiveDays(page)
    },
    shown: archiveDays
  }),
  place({
    name: "Settings, chats: summarization instruction",
    source: "features/chat/ChatDefaults.tsx:303",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/chats")
      return page.getByLabel("Summarization instruction", { exact: true })
    },
    shown: (page) => page.getByLabel("Summarization instruction", { exact: true })
  }),
  place({
    name: "Save a key: addresses",
    source: "features/credentials.tsx:307",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/keys")
      await page.getByRole("button", { name: "Save a key" }).click()
      return page.getByRole("dialog").getByLabel("Addresses it may be sent to", { exact: true })
    },
    shown: (page) => page.getByRole("dialog").getByLabel("Addresses it may be sent to", { exact: true })
  }),
  place({
    name: "Rename a key",
    source: "features/credentials.tsx:331",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        api.CreateCredential({ name: `Durable key ${tag}`, apiKey: "sk-synthetic", urls: ["https://example.com"] })
      ),
    open: async (page, credential, ctx) => {
      await go(page, ctx, "/settings/keys")
      await page.locator("li").filter({ hasText: credential.name }).getByRole("button", { name: "Rename" }).click()
      return page.getByRole("dialog").getByLabel("Name", { exact: true })
    },
    shown: (page) => page.getByRole("dialog").getByLabel("Name", { exact: true })
  }),
  place({
    name: "Network: bypass list",
    source: "features/network.tsx:107",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/network")
      return page.getByLabel("Bypass list", { exact: true })
    },
    shown: (page) => page.getByLabel("Bypass list", { exact: true })
  }),
  place({
    name: "New MCP server: what it's for",
    source: "features/mcp/list.tsx:199",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/mcp/new")
      return page.getByLabel("What it’s for", { exact: true })
    },
    shown: (page) => page.getByLabel("What it’s for", { exact: true })
  }),
  place({
    name: "MCP server: what it's for",
    source: "features/mcp/detail.tsx:212",
    setup: ({ rpc, tag }) => rpc((api) => api.CreateMcpConnection({ settings: mcpSettings(tag) })),
    open: async (page, { connection }, ctx) => {
      await go(page, ctx, `/settings/mcp/${connection.id}`)
      return page.getByLabel("What it’s for", { exact: true })
    },
    shown: (page) => page.getByLabel("What it’s for", { exact: true })
  }),
  place({
    name: "Connection: settings",
    source: "features/connections/detail.tsx:132",
    setup: connection,
    open: async (page, saved, ctx) => {
      await go(page, ctx, `/settings/connections/${saved.id}`)
      return page.getByRole("textbox", { name: "Name", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "Name", exact: true })
  }),
  place({
    name: "New connection: settings",
    source: "features/connections/list.tsx:190",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/connections/new")
      const name = page.getByLabel("Name", { exact: true })
      if ((await name.count()) === 0) await chooseCustomServer(page)
      return name
    },
    shown: (page) => page.getByLabel("Name", { exact: true })
  }),
  ...(
    [
      ["Model settings: a sampler's number", "modelControls.tsx:187", false, "Temperature"],
      ["Model settings: a stop string", "modelControls.tsx:279", false, "Stop string 1"],
      ["Model settings: an extra request parameter (Advanced)", "modelControls.tsx:279", true, "Parameter value 1"]
    ] as const
  ).map(([name, source, advanced, label]) => {
    const box = (scope: Locator) => scope.getByRole("textbox", { name: label, exact: true })
    return place({
      name,
      source: `features/connections/${source}`,
      setup: async (ctx) => {
        const saved = await connection(ctx)
        const key = `durable-${ctx.tag}`
        await ctx.rpc((api) =>
          api.AddUserModel({
            connectionId: saved.id,
            key,
            overrides: { settings: { stop: ["END"] }, sampling: { top_n_sigma: 1 } }
          })
        )
        return { id: saved.id, key }
      },
      open: async (page, { id, key }, ctx) => {
        await go(page, ctx, `/settings/connections/${id}`)
        await page.getByRole("button", { name: `Edit ${key}`, exact: true }).click()
        const dialog = page.getByRole("dialog")
        if (advanced && !(await box(dialog).isVisible())) await dialog.getByText("Advanced", { exact: true }).click()
        return box(dialog)
      },
      shown: (page) => box(page.getByRole("dialog"))
    })
  }),
  place({
    name: "Models: filter",
    source: "features/connections/modelTable.tsx:315",
    setup: async (ctx) => {
      const saved = await connection(ctx)
      await ctx.rpc((api) => api.AddUserModel({ connectionId: saved.id, key: `filter-${ctx.tag}`, overrides: {} }))
      return saved
    },
    open: async (page, saved, ctx) => {
      await go(page, ctx, `/settings/connections/${saved.id}`)
      return page.getByRole("searchbox", { name: "Filter models", exact: true })
    },
    shown: (page) => page.getByRole("searchbox", { name: "Filter models", exact: true })
  }),
  place({
    name: "Add a model: model id",
    source: "features/connections/models.tsx:162",
    setup: connection,
    open: async (page, saved, ctx) => {
      await go(page, ctx, `/settings/connections/${saved.id}`)
      await page.getByRole("button", { name: "Add a model", exact: true }).click()
      return page.getByRole("dialog").getByLabel("Model id", { exact: true })
    },
    shown: (page) => page.getByRole("dialog").getByLabel("Model id", { exact: true })
  }),
  place({
    name: "Costs: pricing formula",
    source: "features/costs.tsx:53",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/costs")
      const name = page.getByLabel("Name", { exact: true }).first()
      await page.getByRole("button", { name: "Add formula", exact: true }).or(name).first().waitFor()
      if ((await name.count()) === 0) await page.getByRole("button", { name: "Add formula", exact: true }).click()
      return name
    },
    shown: (page) => page.getByLabel("Name", { exact: true }).first()
  }),
  place({
    name: "Files: text editor",
    source: "features/files/TextViewer.tsx:124",
    setup: async ({ tag }) => ({ name: `durable-${tag}.txt` }),
    open: async (page, { name }, ctx) => {
      const files = filesOf(page.request, ctx.server.url)
      if (!(await files.has(`/files/${name}`))) await files.put(`/files/${name}`, "Synthetic first line.\n")
      await go(page, ctx, `/files?${new URLSearchParams({ path: "/files", file: name })}`)
      return page.getByRole("textbox", { name: `Contents of ${name}` })
    },
    shown: (page, { name }) => page.getByRole("textbox", { name: `Contents of ${name}` })
  }),
  place({
    name: "Files: rename a file",
    source: "features/files/FileBrowser.tsx:867",
    setup: async ({ tag }) => ({ name: `rename-${tag}.txt` }),
    open: async (page, { name }, ctx) => {
      const files = filesOf(page.request, ctx.server.url)
      if (!(await files.has(`/files/${name}`))) await files.put(`/files/${name}`, "Synthetic line.\n")
      await go(page, ctx, `/files?${new URLSearchParams({ path: "/files" })}`)
      const field = page.getByRole("textbox", { name: `New name for ${name}`, exact: true })
      const actions = page.getByRole("button", { name: `Actions for ${name}`, exact: true })
      await actions.or(field).first().waitFor()
      if (!(await field.isVisible())) {
        await actions.click()
        await page
          .getByRole("menu", { name: `Actions for ${name}` })
          .getByRole("menuitem", { name: "Rename" })
          .click()
      }
      return field
    },
    shown: (page, { name }) => page.getByRole("textbox", { name: `New name for ${name}`, exact: true })
  }),
  place({
    name: "Files: new folder name",
    source: "features/files/FileBrowser.tsx:585",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, `/files?${new URLSearchParams({ path: "/files" })}`)
      const field = page.getByRole("textbox", { name: "Name of the new folder", exact: true })
      const button = page.getByRole("button", { name: "New folder", exact: true })
      await button.or(field).first().waitFor()
      if (!(await field.isVisible())) await button.click()
      return field
    },
    shown: (page) => page.getByRole("textbox", { name: "Name of the new folder", exact: true })
  }),
  place({
    name: "New user: handle",
    source: "features/accounts.tsx:142",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/users")
      const dialog = page.getByRole("dialog", { name: "New user", exact: true })
      const button = page.getByRole("button", { name: "New user", exact: true })
      await button.or(dialog).first().waitFor()
      if (!(await dialog.isVisible())) await button.click()
      return dialog.getByRole("textbox", { name: "Handle", exact: true })
    },
    shown: (page) =>
      page.getByRole("dialog", { name: "New user", exact: true }).getByRole("textbox", { name: "Handle", exact: true })
  }),
  place({
    name: "Media sites: Add a site",
    source: "features/savedMedia/MediaSitesPage.tsx:112",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/media-sites")
      return page.getByRole("textbox", { name: "Site", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "Site", exact: true })
  }),
  place({
    name: "SillyTavern import: folder path",
    source: "features/library/stImport.tsx:834",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/import/st")
      return page.getByRole("textbox", { name: "Folder path", exact: true })
    },
    shown: (page) => page.getByRole("textbox", { name: "Folder path", exact: true })
  }),
  place({
    name: "Bin capacity: item limit",
    source: "features/bin/BinCapacity.tsx:67",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/bin")
      const field = page.getByRole("textbox", { name: "Deleted items: item limit", exact: true })
      const toggle = page.getByText("Bin capacity", { exact: true })
      await toggle.or(field).first().waitFor()
      if (!(await field.isVisible())) await toggle.click()
      return field
    },
    shown: (page) => page.getByRole("textbox", { name: "Deleted items: item limit", exact: true })
  }),
  place({
    name: "New workshop: first message",
    source: "features/workshop/PendingWorkshop.tsx:428",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/new/workshop")
      return page.getByTestId("composer")
    },
    shown: (page) => page.getByTestId("composer")
  }),
  place({
    name: "New workshop: title",
    source: "features/workshop/StartWorkshopPage.tsx:32",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/new/workshop")
      return page.getByLabel("Title of the new workshop", { exact: true })
    },
    shown: (page) => page.getByLabel("Title of the new workshop", { exact: true })
  }),
  place({
    name: "Convert to workshop: workspace instructions",
    source: "features/workshop/ConvertPreset.tsx:150",
    setup: ({ rpc, tag }) => rpc((api) => api.CreatePreset({ label: `Durable preset ${tag}` })),
    open: async (page, preset, ctx) => {
      await go(page, ctx, `/library/${preset.id}`)
      await page.getByRole("button", { name: "Convert to workshop", exact: true }).first().click()
      return page.getByRole("dialog").getByLabel("Workspace instructions", { exact: true })
    },
    shown: (page) => page.getByRole("dialog").getByLabel("Workspace instructions", { exact: true })
  }),
  place({
    name: "New subagent type: instructions",
    source: "features/workshop/SubagentTypes.tsx:240",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/assistant-tools")
      const editor = page.locator('[data-subagent-type-editor="new"]')
      await page.getByRole("button", { name: "New type" }).or(editor).first().waitFor({ timeout: 30_000 })
      if ((await editor.count()) === 0) await page.getByRole("button", { name: "New type" }).click()
      return editor.getByLabel("Instructions", { exact: true })
    },
    shown: (page) => page.locator('[data-subagent-type-editor="new"]').getByLabel("Instructions", { exact: true })
  }),
  place({
    name: "Subagent models: what it's for",
    source: "features/workshop/SubagentSettings.tsx:348",
    setup: async () => null,
    open: async (page, _, ctx) => {
      await go(page, ctx, "/settings/assistant-tools")
      await subagentNote(page).waitFor({ timeout: 30_000 })
      return subagentNote(page)
    },
    shown: subagentNote
  })
]
