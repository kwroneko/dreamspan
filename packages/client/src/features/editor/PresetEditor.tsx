import { Tooltip } from "../../ui/Tooltip.tsx"
// The preset editor (DESIGN §1.2, §6): the prompt list in order, with enable switches and
// drag to reorder; each prompt's role, position and depth; prefill text;
// and the regex scripts, which run only once the user allows them (ARCHITECTURE.md §9).
import { CARD_JOIN_PREFIX, CARD_JOIN_SUFFIX } from "@rp/shared/docs/preset.ts"
import { MERGE_JOIN_DEFAULT, MERGE_SECTION_DEFAULT } from "@rp/shared/mergeApi.ts"
import { ABSENT_GAP_DEFAULT, ABSENT_JOIN_DEFAULT } from "@rp/shared/knowledge.ts"
import { type ReactNode, useState } from "react"
import type { SearchMatch } from "./searchNavigation.ts"
import { PromptDocument } from "./PromptDocument.tsx"
import { usePresetWorkspace } from "./PresetWorkspace.tsx"
import { DocumentRegexScripts } from "./RegexScripts.tsx"
import { presetEditorSections, presetEditorWarnings } from "./presetSections.ts"
import { SlotOutlet } from "../../slots.tsx"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import type { Caller } from "./caller.ts"
import { SelectField, SwitchField, TextField } from "./controls.tsx"
import { type EditorStore, useValue } from "./store.ts"

const POSTFIXES = [
  { value: "", label: "Nothing", description: "The new text follows straight on, mid-word if it starts there." },
  { value: " ", label: "A space", description: "As if the message went on in the same sentence." },
  { value: "\n", label: "A new line", description: "The new text starts on the next line." },
  { value: "\n\n", label: "Two new lines", description: "The new text starts a new paragraph." }
] as const

/**
 * What wraps each character's part of a per-field marker (DESIGN §5.0, ST's group join prefix
 * and suffix). Absent, the default applies, which an empty field doesn't show.
 */
function JoinWrapper({ store, which }: { store: EditorStore; which: "card_join_prefix" | "card_join_suffix" }) {
  const stored = useValue<string | undefined>(store, ["utility_prompts", which])
  const fallback = which === "card_join_prefix" ? CARD_JOIN_PREFIX : CARD_JOIN_SUFFIX
  return (
    <TextField
      store={store}
      path={["utility_prompts", which]}
      label={which === "card_join_prefix" ? "Before each character's part" : "After each character's part"}
      rows={2}
      mono
      about="{{char}} is the character’s name; <FIELDNAME> is the name of the part, such as Description. Empty adds nothing."
      description={stored === undefined ? `Default: ${JSON.stringify(fallback)}` : undefined}
    />
  )
}

/**
 * How a chat merged into another is framed for the model (spec/CHAT-MERGE.md §4): the line before
 * its messages, and the marker where it joins. Absent, the default applies; a merge's own framing
 * line, set when merging, wins over the first.
 */
function MergeTemplate({ store, which }: { store: EditorStore; which: "merge_section_prompt" | "merge_join_prompt" }) {
  const stored = useValue<string | undefined>(store, ["utility_prompts", which])
  const fallback = which === "merge_section_prompt" ? MERGE_SECTION_DEFAULT : MERGE_JOIN_DEFAULT
  return (
    <TextField
      store={store}
      path={["utility_prompts", which]}
      label={which === "merge_section_prompt" ? "Before a merged chat" : "Where a merged chat joins"}
      rows={2}
      about="{{title}} is the merged chat's title; {{cast}} names its characters. Empty adds nothing."
      description={stored === undefined ? `Default: ${JSON.stringify(fallback)}` : undefined}
    />
  )
}

/**
 * In separate contexts (spec/CHARACTER-CONTEXT.md §2.2, unit CU4): the line that stands for the
 * messages a character wasn't present for, and the line where a merged chat's storyline is new
 * to it. Absent, the default applies (the join line's is empty: nothing is sent).
 */
function AbsentTemplate({ store, which }: { store: EditorStore; which: "absent_gap_prompt" | "absent_join_prompt" }) {
  const stored = useValue<string | undefined>(store, ["utility_prompts", which])
  const gap = which === "absent_gap_prompt"
  const fallback = gap ? ABSENT_GAP_DEFAULT : ABSENT_JOIN_DEFAULT
  return (
    <TextField
      store={store}
      path={["utility_prompts", which]}
      label={gap ? "Where a character wasn't present" : "Where a merged storyline is new to a character"}
      rows={2}
      about={
        gap
          ? "With separate contexts, a character's reply leaves out the messages written while it was away; this line stands in their place. {{char}} is the character replying, {{absentCount}} how many messages were left out, {{absentNames}} who took part in them. Example: [Wren wasn't present for 6 messages here, in which Mira and Tobin took part.] Empty adds nothing."
          : "With separate contexts, where a merged chat joins and the character replying wasn't in it. {{mergedNames}} names the merged chat's characters. Example: [Mira and Tobin were elsewhere until now.] Empty, the default, adds nothing."
      }
      description={
        stored === undefined
          ? fallback === ""
            ? "Default: nothing"
            : `Default: ${JSON.stringify(fallback)}`
          : undefined
      }
    />
  )
}

// The group nudge, impersonation prompt, continue nudge and direction have their fixed End of
// request section (DESIGN §2.2).
const UTILITY: ReadonlyArray<readonly [key: string, label: string]> = [
  ["new_chat_prompt", "New chat"],
  ["new_group_chat_prompt", "New group chat"],
  ["new_example_chat_prompt", "New example chat"],
  ["send_if_empty", "Sent when you send nothing"],
  ["wi_format", "Lorebook format ({0} is the entries)"],
  ["scenario_format", "Scenario format"],
  ["personality_format", "Personality format"]
]

export function PresetEditor({
  store,
  call,
  context,
  focus,
  toolbarTarget,
  toolbarEnd,
  onSearchReveal
}: {
  store: EditorStore
  call: Caller
  context?: PresetContext | null | undefined
  focus?: string | undefined
  toolbarTarget?: HTMLElement | null | undefined
  toolbarEnd?: ReactNode
  onSearchReveal?: ((match: SearchMatch) => void) | undefined
}) {
  const [goTo, setGoTo] = useState<{ readonly identifier: string } | null>(null)
  const workspace = usePresetWorkspace()
  return (
    <>
      <SlotOutlet slot={presetEditorWarnings} props={{ store, onGoTo: (identifier) => setGoTo({ identifier }) }} />
      <Card>
        <CardHeader
          title="Prompts"
          about="Reorder what's sent by dragging a handle or an outline name, or with the arrow keys on a focused handle."
        />
        <PromptDocument
          store={store}
          toolbarTarget={toolbarTarget}
          toolbarEnd={toolbarEnd}
          onSearchReveal={onSearchReveal}
          context={context}
          focus={focus}
          goTo={goTo}
          onOpenLorebook={workspace ? (ref) => workspace.open(ref) : undefined}
        />
      </Card>
      <PresetSettings store={store} call={call} />
    </>
  )
}

/**
 * Everything of a preset after its prompt order: the registered sections (the end of request,
 * reply sections), text switches, prefill, utility prompts and regex scripts. The large editor
 * and the side panel's Prompt preset tab both show it.
 */
export function PresetSettings({ store, call }: { store: EditorStore; call: Caller }) {
  return (
    <>
      <SlotOutlet slot={presetEditorSections} props={{ store }} />
      <Card>
        <CardHeader title="Text and context" />
        <div className="flex flex-col gap-3">
          <SwitchField
            store={store}
            path={["pin_examples"]}
            label="Pin example dialogues"
            about="Give examples room before chat history. Off gives history priority. Examples must still fit the context limit."
          />
          <SwitchField
            store={store}
            path={["strip_examples"]}
            label="Strip example dialogues"
            about="Leave out all example dialogues, including lorebook examples, even when pinned."
          />
          <SwitchField
            store={store}
            path={["collapse_newlines"]}
            label="Collapse blank lines in character fields"
            about="Remove extra blank lines from character descriptions sent to the model. Messages and preset prompts keep their blank lines."
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Prefill" about="Left out where the provider can't take it." />
        <div className="flex flex-col gap-3">
          <TextField store={store} path={["prefill", "assistant"]} label="Start of the reply" rows={3} />
          <TextField
            store={store}
            path={["prefill", "impersonation"]}
            label="Start of a reply written as you"
            rows={3}
          />
          {/* No switch for ST's continue prefill (owner, 2026-11-02): nothing here reads it, and
              `prefill.continue` is kept as imported, for exports back to ST. */}
          <SelectField
            store={store}
            path={["prefill", "continue_postfix"]}
            label="After a continued message"
            about="For a model that takes no prefill: what goes between the reply so far and what Continue writes, unless the reply already ends in a space or a line break."
            items={POSTFIXES}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Utility prompts" />
        <details>
          <Tooltip label="Shows the preset’s utility prompts.">
            <summary className="cursor-pointer text-sm text-muted">
              Show the {UTILITY.length + 6} utility prompts
            </summary>
          </Tooltip>
          <div className="mt-3 flex flex-col gap-3">
            {UTILITY.map(([key, label]) => (
              <TextField key={key} store={store} path={["utility_prompts", key]} label={label} rows={3} />
            ))}
            <JoinWrapper store={store} which="card_join_prefix" />
            <JoinWrapper store={store} which="card_join_suffix" />
            <MergeTemplate store={store} which="merge_section_prompt" />
            <MergeTemplate store={store} which="merge_join_prompt" />
            <AbsentTemplate store={store} which="absent_gap_prompt" />
            <AbsentTemplate store={store} which="absent_join_prompt" />
          </div>
        </details>
      </Card>
      <Card>
        <CardHeader title="Regex scripts" />
        <DocumentRegexScripts store={store} call={call} holder="preset" />
      </Card>
    </>
  )
}
