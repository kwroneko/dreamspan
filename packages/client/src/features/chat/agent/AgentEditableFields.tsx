// A card's Model may change list (spec/AGENTIC.md §4.3, `agent_editable_fields`): which of its
// prompt fields agent replies may change with `edit_card`, in every chat that doesn't decide for
// itself. Saved with the card; only the user's own edit sets it (a file or merge never does).
import { REPLACEABLE_CARD_FIELDS, type ReplaceableCardField } from "@rp/shared/docs/note.ts"
import { Checkbox } from "../../../ui/Choice.tsx"
import { Fieldset } from "../../../ui/Field.tsx"
import { CARD_FIELD_LABELS } from "../../editor/noteTargets.ts"
import { type EditorStore, useValue } from "../../editor/store.ts"

const PATH = ["agent_editable_fields"]

export function AgentEditableFields({ store }: { store: EditorStore }) {
  const value = useValue<unknown>(store, PATH)
  const chosen = new Set(Array.isArray(value) ? (value as ReadonlyArray<ReplaceableCardField>) : [])
  const set = (field: ReplaceableCardField, on: boolean) =>
    // In the fields' own order, so the same choice saves the same document.
    store.setValue(
      PATH,
      REPLACEABLE_CARD_FIELDS.filter((f) => (f === field ? on : chosen.has(f)))
    )
  return (
    <Fieldset
      legend="Model may change"
      about="Which of these fields the model may change in chats where it uses tools. A change stays in that chat, as a note, so the card itself is unchanged. A chat can decide for itself in its settings."
    >
      <div data-agent-editable-fields className="flex flex-wrap gap-x-5 gap-y-2">
        {REPLACEABLE_CARD_FIELDS.map((field) => {
          const label = CARD_FIELD_LABELS[field]
          const on = chosen.has(field)
          return (
            <Checkbox
              key={field}
              checked={on}
              hintInline={false}
              hint={
                on ? `Click to stop the model changing the ${label}.` : `Click to let the model change the ${label}.`
              }
              onCheckedChange={(next) => set(field, next)}
            >
              {label}
            </Checkbox>
          )
        })}
      </div>
    </Fieldset>
  )
}
