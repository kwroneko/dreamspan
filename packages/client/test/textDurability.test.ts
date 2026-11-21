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

type Site =
  | {
      readonly durable:
        | "EditorStore"
        | "useUserDraft"
        | "useDurableText"
        | "useDurableForm"
        | "MessageDraft"
        | "SummaryDraft"
        | "ComposerDraft"
        | "FileDraft"
      readonly what: string
      /** The files that hold the store, when callers keep the text this file renders. */
      readonly via?: ReadonlyArray<string>
    }
  | { readonly exempt: string }
  | { readonly gap: string }

/** The boxes: raw and wrapped textareas, the code editor, contenteditable. */
const SITE =
  /<(?:textarea|Textarea|AutoGrowTextarea|CodeEditor|CardTextEditor)\b|component: (?:CodeEditor|AutoGrowTextarea)\b|contentEditable/g

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
