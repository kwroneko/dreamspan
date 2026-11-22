// Text typed in the library: card, preset, lorebook, note, snippet and regex editors, and their dialogs.
import { readFile } from "node:fs/promises"
import type { Locator, Page } from "@playwright/test"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { textField } from "@dreamspan/shared/editing.ts"
import { Effect } from "effect"
import { cardFieldsTab } from "../cardEditor.ts"
import { place, type Place, type PlaceContext } from "../durability.ts"
import { openEntry } from "../lorebook.ts"
import { openPanel } from "../panel.ts"

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
    name: "Open large (Lorebook description)",
    source: "features/editor/controls.tsx:337",
    setup: lazy,
    open: async (page, state, ctx) => {
      await goLibrary(page, ctx, await lorebook(page, ctx, state))
      await bookSettings(page)
      await page.getByRole("button", { name: "Open Lorebook description large" }).click()
      return page.getByRole("dialog", { name: "Lorebook description" }).getByRole("textbox")
    },
    shown: (page) => page.getByRole("dialog", { name: "Lorebook description" }).getByRole("textbox")
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
  })
]
