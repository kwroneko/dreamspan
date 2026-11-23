// Typed text is never lost (ARCHITECTURE §3.10 invariant 1). Every multi-line text box the
// client renders (a textarea, a CodeMirror editor, contenteditable) is listed here, per file,
// each with what keeps its text across a reload: a durable draft store (`durable`, naming the
// store the file must use), a reason it holds no typed text of the user's (`exempt`), or a
// known gap (`gap`, matched by a test.fail() place in e2e/textDurability.spec.ts). A new box
// changes its file's count and fails this test until it's listed, so it can't ship unbacked
// by accident: back it with its target's store (EditorStore, MessageDraft, SummaryDraft,
// ComposerDraft, FileDraft) or, for anything else, the generic one (editor/durable.tsx:
// useDurableText, useDurableForm), and add a Place to the e2e guard.
import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { expect, it } from "vitest"

/** What keeps a field's text: a draft store, the generic hooks, the UI's durable fields, or the URL. */
type Durable =
  | "EditorStore"
  | "useUserDraft"
  | "useDurableText"
  | "useDurableForm"
  | "useDurableFields"
  | "usePlaceParam"
  | "MessageDraft"
  | "SummaryDraft"
  | "ComposerDraft"
  | "FileDraft"

type Site =
  | {
      readonly durable: Durable
      readonly what: string
      /** The files that hold the store, when callers keep the text this file renders. */
      readonly via?: ReadonlyArray<string>
    }
  | { readonly exempt: string }
  | { readonly gap: string }

/** The boxes: raw and wrapped textareas, the code editor, contenteditable. */
const SITE =
  /<(?:textarea|Textarea|AutoGrowTextarea|CodeEditor|MessageTextEditor|CardTextEditor)\b|component: (?:CodeEditor|MessageTextEditor|AutoGrowTextarea)\b|contentEditable/g

const SITES: Readonly<Record<string, ReadonlyArray<Site>>> = {
  // The primitives themselves: whoever renders them is listed.
  "ui/AutoGrowTextarea.tsx": [{ exempt: "primitive: the textarea AutoGrowTextarea wraps" }],
  "ui/Field.tsx": [
    { exempt: "primitive: Textarea without textActions" },
    { exempt: "primitive: Textarea with textActions" }
  ],
  "features/editor/CardTextEditor.tsx": [
    { durable: "EditorStore", what: "the code editor of a library field, given its store and field" }
  ],
  "features/chat/editorHistory.tsx": [
    {
      durable: "MessageDraft",
      what: "message edit, own version and thinking (message.text-editor slot, Message.tsx, editThinking.tsx)"
    },
    { durable: "SummaryDraft", what: "summary edit (summary.text-editor slot, SummaryPanel.tsx)" }
  ],

  // Chat.
  "features/chat/Composer.tsx": [
    { durable: "ComposerDraft", what: "the composer, guidance for a new version included" }
  ],
  "features/chat/QueuedMessages.tsx": [{ durable: "MessageDraft", what: "queued message edit (queue_edit draft)" }],
  "features/chat/insertMessage/InsertEditor.tsx": [
    { durable: "MessageDraft", what: "inserted message (insert draft)" }
  ],
  "features/chat/StartChatPage.tsx": [
    { durable: "useUserDraft", what: "a new chat's first message, with a typed localStorage backup" }
  ],
  "features/chat/ThisChatTab.tsx": [{ durable: "useUserDraft", what: "this chat's summarization instruction" }],
  "features/chat/ChatDefaults.tsx": [{ durable: "useUserDraft", what: "Settings → Chats summarization instruction" }],
  "features/chat/agent/RunSteps.tsx": [{ durable: "useUserDraft", what: "an agent step's text edit" }],
  "features/chat/MergeChatDialog.tsx": [{ durable: "useDurableForm", what: "merge dialog's title and framing line" }],
  "features/chat/agent/ApprovalPanel.tsx": [{ durable: "useDurableText", what: "note for the assistant on Decline" }],
  "features/chat/htmlTextField.tsx": [
    { durable: "useDurableText", what: "a text field in a message's HTML, kept per version and place" }
  ],

  // Library editors.
  "features/editor/CardEditor.tsx": [{ durable: "EditorStore", what: "card text fields (CardTextEditor)" }],
  "features/editor/controls.tsx": [
    { durable: "EditorStore", what: "TextField: code-editor box" },
    { durable: "EditorStore", what: "TextField: prose Textarea" },
    { durable: "EditorStore", what: "LargeField: Open large dialog's box (dialog itself is React state)" },
    { durable: "EditorStore", what: "LinesField" }
  ],
  "features/editor/LorebookEntryDetails.tsx": [
    { durable: "EditorStore", what: "lorebook entry keys (details)" },
    { durable: "EditorStore", what: "lorebook entry primary keys (row)" }
  ],
  "features/editor/RegexScripts.tsx": [
    { durable: "EditorStore", what: "local-binding fields; their owner keeps them (GlobalRegexPage: useUserDraft)" },
    {
      durable: "EditorStore",
      what: "local-binding trim lines; their owner keeps them (GlobalRegexPage: useUserDraft)"
    },
    { durable: "useDurableText", what: "regex Try it sample text" }
  ],
  "features/editor/conflicts.tsx": [
    {
      durable: "useDurableForm",
      what: '"Edit it" text of a conflict, kept with the choices by its callers',
      via: ["features/forkMerge/MergeDialog.tsx", "features/editor/SaveRevision.tsx"]
    }
  ],
  "features/workshop/CardSkills.tsx": [
    { durable: "useDurableForm", what: "card skill dialog's description" },
    { durable: "useDurableForm", what: "card skill dialog's instructions" }
  ],
  "features/workshop/SubagentTypes.tsx": [
    { durable: "useDurableForm", what: "subagent type's description" },
    { durable: "useDurableForm", what: "subagent type's instructions" }
  ],
  "features/workshop/ConvertPreset.tsx": [
    { durable: "useUserDraft", what: "a kept piece's text" },
    { durable: "useUserDraft", what: "workspace instructions" }
  ],
  "features/workshop/PendingWorkshop.tsx": [{ durable: "useUserDraft", what: "a new workshop's first message" }],

  // Settings and other pages.
  "features/credentials.tsx": [{ durable: "useUserDraft", what: "a new key's addresses" }],
  "features/connections/models.tsx": [
    { durable: "useUserDraft", what: "advanced model settings JSON" },
    { durable: "useUserDraft", what: "capability overrides JSON" }
  ],
  "features/network.tsx": [{ durable: "useDurableForm", what: "proxy bypass list (network settings form)" }],
  "features/mcp/list.tsx": [
    { durable: "useDurableForm", what: "new MCP server's \"What it's for\"" },
    { durable: "useDurableForm", what: "arguments (ProgramFields, typed in both MCP forms)" }
  ],
  "features/mcp/detail.tsx": [{ durable: "useDurableForm", what: "MCP server's \"What it's for\"" }],
  "features/files/TextViewer.tsx": [{ durable: "FileDraft", what: "a text file's edit (file draft)" }],

  // Not the user's writing.
  "features/bin/BinPage.tsx": [{ exempt: "read-only: recovered text shown for copying" }],
  "features/editor/BrowserRecovery.tsx": [{ exempt: "read-only: a browser copy shown for copying" }],
  "ui/html/HtmlParts.tsx": [
    {
      exempt:
        "a message's HTML outside a chat (no account to keep it for): uncontrolled; in a chat, features/chat/htmlTextField.tsx keeps it"
    }
  ]
}

it("lists every multi-line text box with what keeps its text across a reload", () => {
  const root = resolve(import.meta.dirname, "../src")
  const found: Record<string, number> = {}
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(path)) {
        const count = (readFileSync(path, "utf8").match(SITE) ?? []).length
        if (count > 0) found[relative(root, path)] = count
      }
    }
  }
  visit(root)
  const listed = Object.fromEntries(Object.entries(SITES).map(([file, sites]) => [file, sites.length]))
  expect(found, "a text box was added or removed: list it in SITES with what keeps its text").toEqual(listed)
  for (const [file, sites] of Object.entries(SITES)) {
    for (const site of sites) {
      if (!("durable" in site)) continue
      // A file its callers keep names none of the stores; one of the callers must.
      const holders = (site.via ?? [file]).map((path) => readFileSync(resolve(root, path), "utf8"))
      expect(
        holders.some((source) => source.includes(site.durable)),
        `${file} is listed as kept by ${site.durable}`
      ).toBe(true)
    }
  }
})

// Every single-line field the client renders: `Input`, a raw `<input>` that takes text, and the
// components that are one (SecretInput, PasswordInput, OneLineField, PickerSearch), listed per
// file as the boxes above are. Inputs that take no typed text (file, checkbox, radio, hidden,
// colour) aren't counted. A secret is never kept anywhere (exempt), nor is a search or filter
// query, which is retyped, not written; everything else is kept by a store. None may be a gap:
// a new field is backed (the generic hooks fit any) before it's listed.
const INPUT = /<(?:Input|input|SecretInput|PasswordInput|OneLineField|PickerSearch)\b/g
const NOT_TEXT = /\btype="(?:file|checkbox|radio|hidden|color)"/

const kept = (durable: Durable, what: string, via?: ReadonlyArray<string>): Site =>
  via ? { durable, what, via } : { durable, what }
const secret: Site = { exempt: "a secret: never kept, in a draft or the browser" }
const search = (what: string): Site => ({ exempt: `search: ${what}` })
const times = (count: number, site: Site) => Array.from({ length: count }, () => site)

const INPUTS: Readonly<Record<string, ReadonlyArray<Site>>> = {
  "ui/Field.tsx": [secret, secret],
  "ui/InlineRename.tsx": [kept("useDurableFields", "a name renamed in place")],
  "ui/OneLineField.tsx": [kept("useDurableFields", "a one-line field with Save and Cancel")],
  "ui/SaveControls.tsx": [kept("useDurableFields", "Save with a message: the revision message")],
  "ui/SearchReplace.tsx": [search("Find"), search("Replace with, beside Find")],
  "ui/html/HtmlParts.tsx": [
    { exempt: "a message's text input outside a message (its preview): nothing to keep it under" },
    { exempt: "an input Markdown made (a task list's box)" },
    { exempt: "a checkbox or radio of a message's HTML" },
    { exempt: "another non-text input of a message's HTML (range, date): no typed text" }
  ],
  "features/accounts.tsx": [
    secret,
    secret,
    kept("useDurableForm", "New user: handle"),
    kept("useDurableForm", "New user: display name"),
    secret,
    secret
  ],
  "features/autoRun/AutoRun.tsx": times(2, kept("usePlaceParam", "Auto replies: replies and token limit")),
  "features/bin/BinCapacity.tsx": [kept("useDurableForm", "Bin capacity: the size typed and its unit")],
  "features/cardForks/surfacesImpl.tsx": [search("Parent card picker's filter")],
  "features/cardSources/SourcesSettings.tsx": [
    secret,
    kept("useDurableForm", "Card sources: cache size limit and unit")
  ],
  "features/cardSources/filters.tsx": times(4, search("a card source's filters (range, value, tag)")),
  "features/characters/ArchiveUnused.tsx": [kept("useDurableForm", "Archive unused: each rule's amount, as typed")],
  "features/characters/CardGridControls.tsx": [search("a card source's query"), search("filter the cards")],
  "features/characters/CardPage.tsx": [search("find a chat")],
  "features/characters/ShellBrowser.tsx": [
    search("find a branch"),
    search("a card source's query"),
    search("find in the list")
  ],
  "features/chat/BranchControl.tsx": [search("find a branch")],
  "features/chat/CardForkDialogs.tsx": times(3, kept("useUserDraft", "fork for this chat: name, version, nickname")),
  "features/chat/CastAdd.tsx": [search("find a character to add")],
  "features/chat/ChatHeader.tsx": [kept("useDurableText", "inline chat name")],
  "features/chat/ChatList.tsx": [search("find a chat")],
  "features/chat/ChatsPage.tsx": [kept("useUserDraft", "title of the new chat")],
  "features/chat/LcmFields.tsx": [kept("useDurableText", "a summarization token number, until it's written")],
  "features/chat/MacroBindings.tsx": [kept("useDurableText", "a macro's name, until Use")],
  "features/chat/MergeChatDialog.tsx": [search("chats to merge"), kept("useDurableForm", "merge title")],
  "features/chat/NameDialog.tsx": [kept("useUserDraft", "chat, group and split names")],
  "features/chat/SpeakerSwitcher.tsx": [search("filter the speakers")],
  "features/chat/StartChatPage.tsx": [kept("useUserDraft", "title of the new chat")],
  "features/chat/VersionPicker.tsx": [search("find in versions")],
  "features/chat/agent/ToolsSection.tsx": [kept("useDurableText", "model requests per reply, until it's saved")],
  "features/chat/htmlTextField.tsx": [kept("useDurableText", "a text input in a message's HTML")],
  "features/chat/nextReplyStrip.tsx": [search("find in a next-reply list")],
  "features/connections/detail.tsx": [
    ...times(4, kept("useUserDraft", "connection name, base URL, concurrency, cache lifetime")),
    secret,
    { exempt: "a header's name, in the headers dialog: it travels with the header's secret value, never kept" },
    secret,
    secret
  ],
  "features/connections/list.tsx": [
    kept("useUserDraft", "new connection: name"),
    kept("useUserDraft", "new connection: base URL"),
    secret,
    kept("useUserDraft", "new connection: model"),
    kept("useUserDraft", "new connection: concurrency")
  ],
  "features/connections/models.tsx": times(4, kept("useUserDraft", "model limits, name, samplers, Add a model")),
  "features/connections/providerFields.tsx": [
    ...times(2, kept("useUserDraft", "region and project", ["features/connections/detail.tsx"])),
    secret,
    secret,
    secret,
    ...times(4, kept("useUserDraft", "cache settings", ["features/connections/detail.tsx"]))
  ],
  "features/costs.tsx": times(8, kept("useUserDraft", "pricing rules and rates")),
  "features/credentials.tsx": [
    { exempt: "an address in Allow for another address: the dialog takes the secret key, and doesn't reopen" },
    secret,
    secret,
    { exempt: "another address in Replace key: the dialog takes the secret key, and doesn't reopen" },
    kept("useUserDraft", "Save a key: name"),
    secret,
    kept("useUserDraft", "Rename a key: name")
  ],
  "features/editor/CardEditor.tsx": [kept("useDurableText", "a card's new tag, until it's added")],
  "features/editor/LorebookEntryDetails.tsx": [kept("EditorStore", "an entry's number setting")],
  "features/editor/LorebookMassEdit.tsx": [kept("useDurableForm", "mass edit: the ticked settings, until Apply")],
  "features/editor/LorebookPicker.tsx": [search("the library's lorebooks")],
  "features/editor/LorebookTable.tsx": [kept("EditorStore", "an entry's title"), search("filter the entries")],
  "features/editor/NewCard.tsx": times(3, kept("useUserDraft", "new card: name, nickname, version")),
  "features/editor/NewDocument.tsx": [kept("useDurableText", "new lorebook or note: name")],
  "features/editor/NewPreset.tsx": [kept("useDurableText", "New prompt preset: name")],
  "features/editor/RefDialogs.tsx": times(3, kept("useUserDraft", "fork or variant: name, subtitle, nickname")),
  "features/editor/RegexScripts.tsx": times(2, kept("EditorStore", "a script's text fields and depth")),
  "features/editor/ReplySectionsSettings.tsx": times(3, kept("EditorStore", "tag pairs and send-back count")),
  "features/editor/controls.tsx": times(2, kept("EditorStore", "TextField and NumberField")),
  "features/editor/lorebookColumns.tsx": [kept("EditorStore", "a column's number"), search("find a lorebook")],
  "features/editor/notes.tsx": [kept("EditorStore", "a note's depth"), search("pick a shared note")],
  "features/files/FileBrowser.tsx": [kept("useDurableText", "rename, new folder and new file names")],
  "features/files/FolderChip.tsx": [kept("useDurableText", "the folder chip's new folder name")],
  "features/files/ShareDialog.tsx": [kept("useDurableText", "Share: account name")],
  "features/gallery/Gallery.tsx": [kept("useDurableText", "Rename image: name")],
  "features/library/list.tsx": [search("the library")],
  "features/library/stImport.tsx": [kept("useDurableText", "SillyTavern import: folder path")],
  "features/login.tsx": [{ exempt: "sign-in handle, beside the password: never kept" }, secret],
  "features/mcp/detail.tsx": [
    ...times(3, kept("useDurableForm", "MCP server: name, URL, timeout")),
    secret,
    { exempt: "a header's name: it travels with the header's secret value, never kept" },
    secret,
    secret
  ],
  "features/mcp/list.tsx": [
    kept("useDurableForm", "new MCP server: name"),
    kept("useDurableForm", "new MCP server: URL"),
    secret,
    kept("useDurableForm", "new MCP server: command")
  ],
  "features/network.tsx": [secret],
  "features/pickers/DocumentPickers.tsx": [search("find a document"), search("find a card")],
  "features/pickers/ModelPicker.tsx": [search("find a model")],
  "features/pickers/PickerParts.tsx": [search("PickerSearch itself; its uses are counted")],
  "features/pickers/PresetPicker.tsx": [search("find a prompt preset")],
  "features/plugins/index.tsx": [search("a plugin registry")],
  "features/savedMedia/MediaSitesPage.tsx": [kept("useDurableText", "Add a site: host")],
  "features/snippets/index.tsx": [search("filter the snippets")],
  "features/threads/StartThreadsDialog.tsx": [kept("useDurableText", "Start threads: the rows, names included")],
  "features/workshop/CardSkills.tsx": times(2, kept("useDurableForm", "a card skill's name and tools")),
  "features/workshop/ConvertPreset.tsx": [kept("useUserDraft", "Convert to workshop: name")],
  "features/workshop/StartWorkshopPage.tsx": [kept("useUserDraft", "title of the new workshop")],
  "features/workshop/SubagentModelsChip.tsx": [search("add a model")],
  "features/workshop/SubagentSettings.tsx": times(4, kept("useDurableForm", "subagent limits and models")),
  "features/workshop/SubagentTypes.tsx": times(3, kept("useDurableForm", "a subagent type's label, id, explanation"))
}

/** The opening tag at `at`, to its closing `>` outside braces. */
const openingTag = (source: string, at: number) => {
  let depth = 0
  for (let i = at + 1; i < source.length; i++) {
    const c = source[i]
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === ">" && depth === 0) return source.slice(at, i + 1)
  }
  return source.slice(at)
}

it("lists every single-line field with what keeps its text across a reload", () => {
  const root = resolve(import.meta.dirname, "../src")
  const found: Record<string, number> = {}
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(path)) {
        const source = readFileSync(path, "utf8")
        const count = [...source.matchAll(INPUT)].filter((m) => !NOT_TEXT.test(openingTag(source, m.index))).length
        if (count > 0) found[relative(root, path)] = count
      }
    }
  }
  visit(root)
  const listed = Object.fromEntries(Object.entries(INPUTS).map(([file, sites]) => [file, sites.length]))
  expect(found, "a single-line field was added or removed: list it in INPUTS with what keeps its text").toEqual(listed)
  for (const [file, sites] of Object.entries(INPUTS))
    for (const site of sites) {
      expect("gap" in site, `${file}: a single-line field loses what's typed: back it before listing it`).toBe(false)
      if (!("durable" in site)) continue
      const holders = (site.via ?? [file]).map((path) => readFileSync(resolve(root, path), "utf8"))
      expect(
        holders.some((source) => source.includes(site.durable)),
        `${file} is listed as kept by ${site.durable}`
      ).toBe(true)
    }
})

// Names renamed in place (ui/InlineRename.tsx): its field keeps what's typed, and that it's
// open, under the `place` its caller gives (the app's durable fields, provided by the shell).
// Every use is listed with its place, so a new one, or two sharing a key, fails here.
const RENAMES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "features/characters/ShellBrowser.tsx": ["`branch-list:${fork.forkId}`"],
  "features/chat/BranchControl.tsx": ["`branch:${fork.id}`"],
  "features/editor/CardNameHeader.tsx": [
    "`card-name:${store.refId}`",
    "`card-version:${store.refId}`",
    "`card-nickname:${store.refId}`"
  ],
  "features/editor/LorebookPanelEditor.tsx": ['`book-name:${store.refId}:${root.join("/")}`'],
  "features/editor/NoteList.tsx": [
    '`note-title:${ref.id}:${chatNote?.chatId ?? ""}:${chatNote?.forkId ?? ""}:${chatNote?.slotId ?? ""}`'
  ],
  "features/editor/PromptDocument.tsx": ["`prompt-name:${store.refId}:${entry.identifier}`"],
  "features/editor/RefDialogs.tsx": ["`ref-name:${ref.id}`"],
  "features/snippets/SnippetLarge.tsx": ["`snippet-title:large:${refId}`"],
  "features/snippets/index.tsx": ["`snippet-title:${item.ref.id}`"],
  "features/threads/ThreadsSection.tsx": ["`thread:${thread.forkId}:${thread.ordinal}`"],
  // RevisionEntry's place, from CardRevisionBrowser: `revision:${revision.id}`.
  "ui/RevisionMessage.tsx": ["place"]
}

it("keeps what's typed in every name renamed in place, under a place of its own", () => {
  const root = resolve(import.meta.dirname, "../src")
  const rename = readFileSync(resolve(root, "ui/InlineRename.tsx"), "utf8")
  expect(rename).toMatch(/useDurableFields\(\)/)
  expect(rename).toMatch(/\.useOpen\(`rename:\$\{place\}`\)/)
  expect(rename).toMatch(/useText\(`rename:\$\{place\}`/)
  expect(readFileSync(resolve(root, "features/shell.tsx"), "utf8")).toContain(
    "<DurableFieldsContext value={appDurableFields}>"
  )
  const found: Record<string, Array<string>> = {}
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(path) && !path.endsWith("ui/InlineRename.tsx")) {
        const source = readFileSync(path, "utf8")
        for (const use of source.matchAll(/<InlineRename\b/g)) {
          const head = source.slice(use.index).split("\n").slice(0, 2).join(" ")
          const place = /^<InlineRename\s+place=\{(.+?)\}(?:\s|>|$)/.exec(head)
          ;(found[relative(root, path)] ??= []).push(place?.[1] ?? "(none)")
        }
      }
    }
  }
  visit(root)
  expect(found, "an InlineRename was added or its place changed: list it in RENAMES").toEqual(RENAMES)
  const places = Object.values(RENAMES).flat()
  expect(new Set(places).size, "two InlineRenames share a place").toBe(places.length)
})
