// The preset editor (DESIGN §1.2, §6): the prompt list in order, with enable switches and
// drag to reorder; each prompt's role, position and depth; prefill text;
// and the regex scripts, which run only once the user allows them (ARCHITECTURE.md §9).
import { CARD_JOIN_PREFIX, CARD_JOIN_SUFFIX } from "@rp/shared/docs/preset.ts"
import { useState } from "react"
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
      description={
        stored === undefined
          ? `Not set: ${JSON.stringify(fallback)} is used. {{char}} is the character, <FIELDNAME> the field.`
          : "{{char}} is the character, <FIELDNAME> the field. Empty: nothing."
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
  focus
}: {
  store: EditorStore
  call: Caller
  context?: PresetContext | null | undefined
  focus?: string | undefined
}) {
  const [goTo, setGoTo] = useState<{ readonly identifier: string } | null>(null)
  const workspace = usePresetWorkspace()
  return (
    <>
      <SlotOutlet slot={presetEditorWarnings} props={{ store, onGoTo: (identifier) => setGoTo({ identifier }) }} />
      <Card>
        <CardHeader
          title="Prompts"
          description="Sent in this order. Drag a handle or an outline name; arrow keys move a focused handle."
        />
        <PromptDocument
          store={store}
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
        <CardHeader title="Text and context" description="How example dialogues and character fields are sent." />
        <div className="flex flex-col gap-3">
          <SwitchField store={store} path={["pin_examples"]} label="Pin example dialogues" />
          <p className="text-sm text-muted">
            Give examples room before chat history. Off: history takes priority. Examples still need to fit the context
            limit.
          </p>
          <SwitchField store={store} path={["strip_examples"]} label="Strip example dialogues" />
          <p className="text-sm text-muted">
            Send no example dialogues, including lorebook examples. This takes priority over pinning.
          </p>
          <SwitchField store={store} path={["collapse_newlines"]} label="Collapse blank lines in character fields" />
          <p className="text-sm text-muted">
            Replace repeated newlines with one after expanding character fields. Saved messages and preset prompts keep
            their blank lines.
          </p>
        </div>
      </Card>
      <Card>
        <CardHeader title="Prefill" description="Dropped where the provider can't take it." />
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
            description="For a model that takes no prefill: what goes between the reply so far and what Continue writes, unless the reply already ends in a space or a line break."
            items={POSTFIXES}
          />
        </div>
      </Card>
      <Card>
        <CardHeader title="Utility prompts" description="Text used in particular situations." />
        <details>
          <summary className="cursor-pointer text-sm text-muted">Show the {UTILITY.length} utility prompts</summary>
          <div className="mt-3 flex flex-col gap-3">
            {UTILITY.map(([key, label]) => (
              <TextField key={key} store={store} path={["utility_prompts", key]} label={label} rows={3} />
            ))}
            <JoinWrapper store={store} which="card_join_prefix" />
            <JoinWrapper store={store} which="card_join_suffix" />
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
