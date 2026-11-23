// Text typed in the library: card, preset, lorebook, note, snippet and regex editors, and their dialogs.
import { readFile } from "node:fs/promises"
import type { Locator, Page } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { Effect } from "effect"
import { cardFieldsTab } from "../cardEditor.ts"
import { openRename, place, renameField, type Place, type PlaceContext } from "../durability.ts"
import { openEntry } from "../lorebook.ts"
import { openPanel } from "../panel.ts"
import { portraitPng } from "../portrait.ts"

/** Fixtures made from the page (an import is an HTTP upload with the page's login), once per test. */
interface Lazy {
  refId?: string
}

const importFile = async (page: Page, { server }: PlaceContext, name: string, bytes: Buffer, into?: string) => {
  const response = await page.request.post(
    `${server.url}/library/import?name=${encodeURIComponent(name)}${into ? `&into=${into}` : ""}`,
    { headers: { "content-type": "application/octet-stream", origin: server.url }, data: bytes }
  )
  if (response.status() !== 200) throw new Error(`import of ${name} failed: ${response.status()}`)
  return ((await response.json()) as { library: { ref: { id: string } } }).library.ref.id
}

const presetBytes = async (main: string) => {
  const file = JSON.parse(
    await readFile(new URL("../../../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
  ) as { prompts: Array<{ identifier: string; content: string }> }
  file.prompts.find((p) => p.identifier === "main")!.content = main
  return Buffer.from(JSON.stringify(file))
}

// A synthetic ST world info file.
const worldInfo = (name: string) =>
  Buffer.from(
    JSON.stringify({
      name,
      entries: {
        0: { uid: 0, key: ["harbour", "quay"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 }
      }
    })
  )

// The same with a second entry, for editing several at once.
const twoEntries = (name: string) =>
  Buffer.from(
    JSON.stringify({
      name,
      entries: {
        0: { uid: 0, key: ["harbour"], comment: "Harbour", content: "Boats rock at the quay.", order: 10 },
        1: { uid: 1, key: ["lamp"], comment: "Lamp", content: "The lamp is lit.", order: 20 }
      }
    })
  )

const goLibrary = async (page: Page, { server }: PlaceContext, refId: string) => {
  await page.goto(`${server.url}/library/${refId}`)
  await page.getByRole("heading", { level: 1 }).first().waitFor()
}

const card = ({ rpc, tag }: PlaceContext) =>
  rpc((api) => Effect.map(api.CreateCard({ label: `Wren ${tag}`, name: "Wren" }), (made) => ({ refId: made.id })))

const preset = async (page: Page, ctx: PlaceContext, state: Lazy) =>
  (state.refId ??= await importFile(page, ctx, `Preset ${ctx.tag}.json`, await presetBytes("Write vivid prose.")))

const lorebook = async (page: Page, ctx: PlaceContext, state: Lazy) =>
  (state.refId ??= await importFile(page, ctx, `Saltmarsh ${ctx.tag}.json`, worldInfo(`Saltmarsh ${ctx.tag}`)))

const massGroup = (page: Page) =>
  page.getByRole("dialog", { name: "Edit 2 entries", exact: true }).getByRole("textbox", { name: "Group", exact: true })
const imageName = (page: Page) =>
  page.getByRole("dialog", { name: "Rename image", exact: true }).getByRole("textbox", { name: "Name", exact: true })

const field = (page: Page, name: string | RegExp) => page.getByRole("textbox", { name })
const harbour = (page: Page) => page.getByRole("group", { name: "Lorebook entry 0", exact: true })

/** Opens the book settings of a standalone lorebook, a <details> closed by default. */
const bookSettings = async (page: Page) => {
  const box = field(page, "Lorebook description")
  if (!(await box.isVisible())) await page.getByText("Book settings", { exact: false }).first().click()
  return box
}

/** Types into a box hidden until focused (the entry's keys): focus, not click. */
const focusAndType = async (box: Locator, marker: string) => {
  await box.focus()
  await box.press("ControlOrMeta+End")
  await box.page().keyboard.insertText(` ${marker}`)
}

/** A preset whose import of another version conflicts on the main prompt: Review and merge shows one conflict. */
const conflicting = async (page: Page, ctx: PlaceContext, state: Lazy) => {
  if (state.refId !== undefined) return state.refId
  const refId = (await importFile(page, ctx, "preset.json", await presetBytes("Write vivid prose."))) as RefId
  await ctx.rpc((api) =>
    Effect.gen(function* () {
      const opened = yield* api.OpenEditor({ refId })
      const draft = yield* api.SaveEditorDraft({
        draftId: null,
        expectedSession: null,
        refId,
        field: textField(["prompts", "identifier=main", "content"]),
        content: "Write calm prose.",
        expectedRowVersion: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
    })
  )
  await importFile(page, ctx, "preset.json", await presetBytes("Write terse prose."), refId)
  return (state.refId = refId)
}
const conflictItem = (page: Page) =>
  page
    .getByRole("dialog", { name: /^Merge into / })
    .getByRole("list", { name: /^Conflicts in/ })
    .getByRole("listitem")

const snippetChat = ({ rpc, tag }: PlaceContext) =>
  rpc((api) =>
    Effect.gen(function* () {
      const chat = yield* api.CreateChat({ title: `Snippets ${tag}` })
      yield* api.CreateSnippet({ chatId: chat.id, title: `Lines ${tag}`, content: "The beam sweeps the bay." })
      return { chatId: chat.id as ChatId, title: `Lines ${tag}` }
    })
  )

const lazy = async (): Promise<Lazy> => ({})

export const libraryPlaces: ReadonlyArray<Place> = [
  place({
    name: "Card field (Description)",
    source: "features/editor/CardTextEditor.tsx:85",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      return field(page, /^Description/)
    },
    shown: (page) => field(page, /^Description/)
  }),
  place({
    name: "Card regex script (Replace with)",
    source: "features/editor/RegexScripts.tsx:97",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      const extra = await cardFieldsTab(page, "Extra")
      const scripts = extra.getByRole("list", { name: "Regex scripts" })
      if ((await scripts.count()) === 0) await extra.getByRole("button", { name: "Add a script", exact: true }).click()
      const edit = scripts.getByRole("button", { name: /^Edit / }).first()
      if ((await edit.getAttribute("aria-expanded")) !== "true") await edit.click()
      return scripts.getByRole("textbox", { name: /^Replace with/ })
    },
    shown: (page) => page.getByRole("list", { name: "Regex scripts" }).getByRole("textbox", { name: /^Replace with/ })
  }),
  place({
    name: "Card regex Try it sample",
    source: "features/editor/RegexScripts.tsx:355",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      const extra = await cardFieldsTab(page, "Extra")
      const scripts = extra.getByRole("list", { name: "Regex scripts" })
      if ((await scripts.count()) === 0) await extra.getByRole("button", { name: "Add a script", exact: true }).click()
      const edit = scripts.getByRole("button", { name: /^Edit / }).first()
      if ((await edit.getAttribute("aria-expanded")) !== "true") await edit.click()
      await scripts.getByText("Try it", { exact: true }).click()
      return scripts.getByRole("textbox", { name: "Sample text" })
    },
    shown: (page) => page.getByRole("textbox", { name: "Sample text" })
  }),
  place({
    name: "Card skill instructions",
    source: "features/workshop/CardSkills.tsx:107",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      await cardFieldsTab(page, "Extra")
      await page.getByRole("button", { name: "Add a skill", exact: true }).click()
      return page.getByRole("dialog", { name: "Add a skill" }).getByRole("textbox", { name: "Instructions" })
    },
    shown: (page) => page.getByRole("dialog", { name: "Add a skill" }).getByRole("textbox", { name: "Instructions" })
  }),
  place({
    name: "New card dialog",
    source: "features/editor/NewCard.tsx:95",
    setup: lazy,
    open: async (page, _state, { server }) => {
      await page.goto(`${server.url}/library`)
      const dialog = page.getByRole("dialog", { name: "New card" })
      if (!(await dialog.isVisible())) await page.getByRole("button", { name: "New card" }).first().click()
      return dialog.getByRole("textbox", { name: "Display name", exact: true })
    },
    shown: (page) => page.getByRole("dialog", { name: "New card" }).getByRole("textbox", { name: "Display name" })
  }),
  place({
    name: "New lorebook dialog",
    source: "features/editor/NewDocument.tsx:69",
    setup: lazy,
    open: async (page, _state, { server }) => {
      await page.goto(`${server.url}/library?kind=lorebook`)
      const dialog = page.getByRole("dialog", { name: "New lorebook", exact: true })
      if (!(await dialog.isVisible())) await page.getByRole("button", { name: "New lorebook", exact: true }).click()
      return dialog.getByRole("textbox", { name: "Name", exact: true })
    },
    shown: (page) =>
      page
        .getByRole("dialog", { name: "New lorebook", exact: true })
        .getByRole("textbox", { name: "Name", exact: true })
  }),
  place({
    name: "New card dialog (card switcher)",
    source: "features/editor/DocumentSwitcher.tsx:96",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      await page.getByRole("button", { name: "Switch card", exact: true }).click()
      await page
        .getByRole("dialog", { name: "Card", exact: true })
        .getByRole("button", { name: "New card…", exact: true })
        .click()
      return page
        .getByRole("dialog", { name: "New card", exact: true })
        .getByRole("textbox", { name: "Display name", exact: true })
    },
    shown: (page) =>
      page
        .getByRole("dialog", { name: "New card", exact: true })
        .getByRole("textbox", { name: "Display name", exact: true })
  }),
  place({
    name: "Fork card dialog",
    source: "features/editor/RefDialogs.tsx:34",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      await page.getByRole("button", { name: "Fork", exact: true }).click()
      return page.getByRole("dialog", { name: "Fork card" }).getByRole("textbox", { name: "Display name", exact: true })
    },
    shown: (page) =>
      page.getByRole("dialog", { name: "Fork card" }).getByRole("textbox", { name: "Display name", exact: true })
  }),
  place({
    name: "Preset prompt text",
    source: "features/editor/PromptDocument.tsx:691",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await preset(page, ctx, state))
      return field(page, /^Prompt: Main Prompt/)
    },
    shown: (page) => field(page, /^Prompt: Main Prompt/)
  }),
  place({
    name: "Preset prefill (Start of the reply)",
    source: "features/editor/PresetEditor.tsx:189",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await preset(page, ctx, state))
      return field(page, /^Start of the reply/)
    },
    shown: (page) => field(page, /^Start of the reply/)
  }),
  place({
    name: "Merge conflict Edit it",
    source: "features/editor/conflicts.tsx:124 (draft: forkMerge/MergeDialog.tsx:242)",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await conflicting(page, ctx, state))
      await page.getByRole("button", { name: "Review and merge" }).click()
      await conflictItem(page).getByRole("radio", { name: "Edit it" }).click()
      return conflictItem(page).getByRole("textbox")
    },
    shown: (page) => conflictItem(page).getByRole("textbox")
  }),
  place({
    name: "Lorebook description",
    source: "features/editor/controls.tsx:279",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await lorebook(page, ctx, state))
      return bookSettings(page)
    },
    shown: (page) => field(page, "Lorebook description")
  }),
  place({
    name: "Field in its own tab (Lorebook description)",
    source: "features/editor/controls.tsx:358",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await lorebook(page, ctx, state))
      await bookSettings(page)
      await field(page, "Lorebook description").click()
      await page.getByRole("link", { name: "Open Lorebook description in a tab", exact: true }).click()
      return page.locator("[data-field-tab]").getByRole("textbox")
    },
    shown: (page) => page.locator("[data-field-tab]").getByRole("textbox")
  }),
  place({
    name: "Field in its own tab (card Description)",
    source: "features/editor/controls.tsx:358",
    setup: card,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, state.refId)
      await field(page, "Description").first().click()
      await page.getByRole("link", { name: "Open Description in a tab", exact: true }).click()
      return page.locator("[data-field-tab]").getByRole("textbox", { name: "Description" })
    },
    shown: (page) => page.locator("[data-field-tab]").getByRole("textbox", { name: "Description" })
  }),
  place({
    name: "Lorebook entry content",
    source: "features/editor/LorebookEntryDetails.tsx:436",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await lorebook(page, ctx, state))
      await openEntry(page, "Harbour")
      return harbour(page).getByRole("textbox", { name: "Entry content" })
    },
    shown: (page) => harbour(page).getByRole("textbox", { name: "Entry content" })
  }),
  place({
    name: "Lorebook entry keys",
    source: "features/editor/LorebookEntryDetails.tsx:162",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await lorebook(page, ctx, state))
      await openEntry(page, "Harbour")
      return harbour(page).getByRole("textbox", { name: "Primary keys" })
    },
    shown: (page) => harbour(page).getByRole("textbox", { name: "Primary keys" }),
    type: focusAndType
  }),
  place({
    name: "Shared note page (Content)",
    source: "features/editor/notes.tsx:614",
    setup: ({ rpc, tag }) =>
      rpc((api) =>
        Effect.map(api.CreateSharedNote({ title: `Tide ${tag}`, content: "High water at six." }), (made) => ({
          refId: made.id
        }))
      ),
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      return field(page, /^Content/)
    },
    shown: (page) => field(page, /^Content/)
  }),
  place({
    name: "Snippet in the chat panel",
    source: "features/snippets/index.tsx:249",
    setup: snippetChat,
    open: async (page, { chatId, title }, { server }) => {
      await page.goto(`${server.url}/chats/${chatId}`)
      const panel = await openPanel(page, "Snippets")
      // Its block opens by itself once loaded, or waits for Expand.
      const toggle = panel.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${title}$`) })
      if ((await toggle.getAttribute("aria-label"))?.startsWith("Expand")) await toggle.click()
      return panel.getByRole("textbox", { name: `Text of ${title}` })
    },
    shown: (page, { title }) =>
      page.getByRole("tabpanel", { name: "Snippets" }).getByRole("textbox", { name: `Text of ${title}` })
  }),
  place({
    name: "Snippet large editor",
    source: "features/snippets/SnippetLarge.tsx:158",
    setup: snippetChat,
    open: async (page, { chatId, title }, { server }) => {
      await page.goto(`${server.url}/chats/${chatId}`)
      const panel = await openPanel(page, "Snippets")
      await panel.getByRole("button", { name: `Open ${title} in the large editor`, exact: true }).click()
      return page.getByRole("region", { name: "Snippet editor" }).getByRole("textbox", { name: `Text of ${title}` })
    },
    shown: (page, { title }) =>
      page.getByRole("region", { name: "Snippet editor" }).getByRole("textbox", { name: `Text of ${title}` })
  }),
  place({
    name: "Global regex script (Replace with)",
    source: "features/editor/RegexScripts.tsx:133",
    setup: lazy,
    open: async (page, _state, { server }) => {
      await page.goto(`${server.url}/settings/regex`)
      await page.getByRole("heading", { name: "Global regex scripts" }).waitFor()
      const list = page.getByRole("list", { name: "Global regex scripts" })
      if ((await list.count()) === 0 || (await list.getByRole("listitem").count()) === 0)
        await page.getByRole("button", { name: "Add a script", exact: true }).click()
      const item = list.getByRole("listitem").last()
      const box = item.getByRole("textbox", { name: "Replace with" })
      if (!(await box.isVisible())) await item.getByRole("button", { name: /^Edit / }).click()
      return box
    },
    shown: (page) =>
      page.getByRole("list", { name: "Global regex scripts" }).getByRole("textbox", { name: "Replace with" })
  }),
  place({
    name: "New prompt preset dialog",
    source: "features/editor/NewPreset.tsx:82",
    setup: lazy,
    open: async (page, _state, { server }) => {
      await page.goto(`${server.url}/library?kind=preset`)
      const dialog = page.getByRole("dialog", { name: "New prompt preset", exact: true })
      const button = page.getByRole("button", { name: "New prompt preset", exact: true })
      await button.or(dialog).first().waitFor()
      if (!(await dialog.isVisible())) await button.click()
      return dialog.getByRole("textbox", { name: "Name", exact: true })
    },
    shown: (page) =>
      page
        .getByRole("dialog", { name: "New prompt preset", exact: true })
        .getByRole("textbox", { name: "Name", exact: true })
  }),
  place({
    name: "Card: new tag",
    source: "features/editor/CardEditor.tsx:213",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      const metadata = await cardFieldsTab(page, "Metadata")
      return metadata.getByRole("list", { name: "Tags" }).getByRole("textbox", { name: "New tag" })
    },
    shown: (page) => page.getByRole("list", { name: "Tags" }).getByRole("textbox", { name: "New tag" })
  }),
  place({
    name: "Card display name (rename in place)",
    source: "features/editor/CardNameHeader.tsx:266",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      return openRename(page, "Rename the display name", "Display name")
    },
    shown: (page) => renameField(page, "Display name")
  }),
  place({
    name: "Card nickname (rename in place)",
    source: "features/editor/CardNameHeader.tsx:338",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      return openRename(page, "Rename the nickname", "In-chat nickname")
    },
    shown: (page) => renameField(page, "In-chat nickname")
  }),
  place({
    name: "Lorebook name (rename in place)",
    source: "features/editor/RefDialogs.tsx:187",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await lorebook(page, ctx, state))
      return openRename(page, `Rename Saltmarsh ${ctx.tag}`, `New name for Saltmarsh ${ctx.tag}`)
    },
    shown: (page) => renameField(page, /^New name for Saltmarsh /)
  }),
  place({
    name: "Preset prompt name (rename in place)",
    source: "features/editor/PromptDocument.tsx:517",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await preset(page, ctx, state))
      return openRename(page, "Rename Main Prompt", "New name for Main Prompt")
    },
    shown: (page) => renameField(page, "New name for Main Prompt")
  }),
  place({
    name: "Save with a message: revision message",
    source: "ui/OneLineField.tsx:52",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      const message = page.getByRole("textbox", { name: "Revision message", exact: true })
      const description = field(page, /^Description/)
      await description.or(message).first().waitFor()
      if (!(await message.isVisible())) {
        // Save with a message needs something to save.
        await description.click()
        await page.keyboard.insertText(" Changed.")
        await page.getByRole("button", { name: "Save with message…", exact: true }).click()
      }
      return message
    },
    shown: (page) => page.getByRole("textbox", { name: "Revision message", exact: true })
  }),
  place({
    name: "Revision message (History)",
    source: "ui/RevisionMessage.tsx:55",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await goLibrary(page, ctx, refId)
      const history = page.getByRole("dialog", { name: "History", exact: true })
      if (!(await history.isVisible())) await page.getByRole("button", { name: "History", exact: true }).click()
      return openRename(history, /^(Add message to|Edit message of) Revision /, /^Message of Revision /)
    },
    shown: (page) => renameField(page.getByRole("dialog", { name: "History", exact: true }), /^Message of Revision /)
  }),
  place({
    name: "Snippet title in the chat panel (rename in place)",
    source: "features/snippets/index.tsx:216",
    setup: snippetChat,
    open: async (page, { chatId, title }, { server }) => {
      await page.goto(`${server.url}/chats/${chatId}`)
      const panel = await openPanel(page, "Snippets")
      return openRename(panel, `Rename ${title}`, `New name for ${title}`)
    },
    shown: (page, { title }) => renameField(page.getByRole("tabpanel", { name: "Snippets" }), `New name for ${title}`)
  }),
  place({
    name: "Snippet title in the large editor (rename in place)",
    source: "features/snippets/SnippetLarge.tsx:93",
    setup: snippetChat,
    open: async (page, { chatId, title }, { server }) => {
      await page.goto(`${server.url}/chats/${chatId}`)
      const editor = page.getByRole("region", { name: "Snippet editor" })
      if (!(await editor.isVisible())) {
        const panel = await openPanel(page, "Snippets")
        await panel.getByRole("button", { name: `Open ${title} in the large editor`, exact: true }).click()
      }
      return openRename(editor, `Rename ${title}`, `New name for ${title}`)
    },
    shown: (page, { title }) =>
      renameField(page.getByRole("region", { name: "Snippet editor" }), `New name for ${title}`)
  }),
  place<Lazy>({
    name: "Lorebook: edit several entries at once",
    source: "features/editor/LorebookMassEdit.tsx:165",
    setup: async () => ({}),
    open: async (page, state, ctx) => {
      state.refId ??= await importFile(page, ctx, `Tides ${ctx.tag}.json`, twoEntries(`Tides ${ctx.tag}`))
      await goLibrary(page, ctx, state.refId)
      for (const title of ["Harbour", "Lamp"])
        await page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).click()
      await page.getByRole("button", { name: "Edit 2 entries", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Edit 2 entries", exact: true })
      await dialog.getByRole("checkbox", { name: "Change Group", exact: true }).click()
      return massGroup(page)
    },
    shown: massGroup
  }),
  place({
    name: "Gallery: rename an image",
    source: "features/gallery/Gallery.tsx:312",
    setup: card,
    open: async (page, { refId }, ctx) => {
      await page.goto(`${ctx.server.url}/library/${refId}?cardTab=Extra`)
      await page.getByRole("tab", { name: "Extra", exact: true }).click()
      const add = page.locator("[data-gallery]").getByRole("button", { name: "Add images", exact: true })
      await add.waitFor()
      if ((await page.locator("[data-gallery-image]").count()) === 0) {
        const chooser = page.waitForEvent("filechooser")
        await add.click()
        await (await chooser).setFiles([{ name: "Coat.png", mimeType: "image/png", buffer: portraitPng([], 1) }])
        await page.locator("[data-gallery-image]").first().waitFor()
      }
      await page.getByRole("button", { name: "Actions for Coat", exact: true }).click()
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
      return imageName(page)
    },
    shown: imageName
  })
]
