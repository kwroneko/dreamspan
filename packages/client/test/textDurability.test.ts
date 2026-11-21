// Typed text is never lost (ARCHITECTURE §3.10 invariant 1). Every multi-line text box the
// client renders (a textarea, a CodeMirror editor, contenteditable) is listed here, per file,
// each with what keeps its text across a reload: a durable draft store (`durable`, naming the
// store the file must use), a reason it holds no typed text of the user's (`exempt`), or a
// known gap (`gap`, matched by a test.fail() place in e2e/textDurability.spec.ts). A new box
// changes its file's count and fails this test until it's listed, so it can't ship unbacked
// by accident: back it with one of the stores (EditorStore, useUserDraft, MessageDraft,
// SummaryDraft, ComposerDraft, FileDraft) and add a Place to the e2e guard.
import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { expect, it } from "vitest"

type Site =
  | {
      readonly durable: "EditorStore" | "useUserDraft" | "MessageDraft" | "SummaryDraft" | "ComposerDraft" | "FileDraft"
      readonly what: string
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
    { durable: "ComposerDraft", what: "the composer (and, today, the guidance-edit box; see the gap below)" }
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
  "features/chat/MergeChatDialog.tsx": [{ gap: "merge dialog's framing line: React state only, lost on reload" }],
  "features/chat/agent/ApprovalPanel.tsx": [{ gap: "note for the assistant on Decline/Don't run: React state only" }],

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
    { gap: "regex Try it sample text: React state only" }
  ],
  "features/editor/conflicts.tsx": [
    {
      gap: '"Edit it" text of a conflict: its caller keeps the choice. A fork merge keeps it in a server draft (forkMerge/MergeDialog.tsx, "Merge choices"), but the dialog closes on reload; a save conflict (SaveRevision.tsx) keeps it in React state only'
    }
  ],
  "features/workshop/CardSkills.tsx": [
    { gap: "card skill dialog's description: React state until Save writes the card" },
    { gap: "card skill dialog's instructions: React state until Save writes the card" }
  ],
  "features/workshop/SubagentTypes.tsx": [
    { gap: "subagent type's description: React state only" },
    { gap: "subagent type's instructions: React state only" }
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
  "features/network.tsx": [{ gap: "proxy bypass list: React state only" }],
  "features/mcp/list.tsx": [
    { gap: "new MCP server's \"What it's for\": React state only" },
    { gap: "new MCP server's arguments: React state only" }
  ],
  "features/mcp/detail.tsx": [{ gap: "MCP server's \"What it's for\": React state only" }],
  "features/files/TextViewer.tsx": [{ durable: "FileDraft", what: "a text file's edit (file draft)" }],

  // Not the user's writing.
  "features/bin/BinPage.tsx": [{ exempt: "read-only: recovered text shown for copying" }],
  "features/editor/BrowserRecovery.tsx": [{ exempt: "read-only: a browser copy shown for copying" }],
  "ui/html/HtmlParts.tsx": [
    {
      gap: "a <textarea> in a message's own HTML: uncontrolled, the page's, not saved; typing in it is lost on reload (judged acceptable? owner to decide)"
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
    const source = readFileSync(resolve(root, file), "utf8")
    for (const site of sites)
      if ("durable" in site) expect(source, `${file} is listed as kept by ${site.durable}`).toContain(site.durable)
  }
})
