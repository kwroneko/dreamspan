// Tagged sections at the start of a reply (spec/REPLY-SECTIONS.md): which opening and closing
// patterns take a leading section out of the reply into its own panel, whether that's on, and
// how many recent replies send theirs back. The whole setting is one field of the preset;
// absent, the defaults show and the first change writes them out.
import {
  DEFAULT_REPLY_SECTIONS,
  DEFAULT_SECTION_PAIR,
  type ReplySectionSettings,
  type SectionPair
} from "@rp/shared/replySections.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { type EditorStore, useValue } from "./store.ts"

const PATH = ["reply_sections"]

/** Why the browser can't read a pattern; the server also skips what its linear-time engine can't run. */
const patternError = (pattern: string) => {
  if (pattern === "") return "Empty: this pair is skipped."
  try {
    new RegExp(pattern)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : "Not a regular expression."
  }
}

function PairRow({
  pair,
  index,
  onChange,
  onRemove
}: {
  pair: SectionPair
  index: number
  onChange: (pair: SectionPair) => void
  onRemove: () => void
}) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3" data-section-pair={index}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Opening tag" error={patternError(pair.open)}>
          <Input
            value={pair.open}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => onChange({ ...pair, open: event.currentTarget.value })}
          />
        </Field>
        <Field label="Closing tag" error={patternError(pair.close)}>
          <Input
            value={pair.close}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => onChange({ ...pair, close: event.currentTarget.value })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Checkbox
          checked={pair.case_sensitive === true}
          onCheckedChange={(checked) => {
            const { case_sensitive: _, ...rest } = pair
            onChange(checked ? { ...rest, case_sensitive: true } : rest)
          }}
        >
          Match case
        </Checkbox>
        <Button variant="ghost" onClick={onRemove}>
          Remove pair
        </Button>
      </div>
    </li>
  )
}

export function ReplySectionsSettings({ store }: { store: EditorStore }) {
  const stored = useValue<ReplySectionSettings | undefined>(store, PATH)
  const settings = stored ?? DEFAULT_REPLY_SECTIONS
  const change = (next: Partial<ReplySectionSettings>) => store.setValue(PATH, { ...settings, ...next })
  const setPair = (index: number, pair: SectionPair) =>
    change({ pairs: settings.pairs.map((other, i) => (i === index ? pair : other)) })
  return (
    <Card>
      <CardHeader
        title="Notes at the start of a reply"
        description="A section the reply starts with, in these tags, shows in its own folded panel above the reply instead of in its text."
      />
      <div className="flex flex-col gap-4" data-preset-section="reply-sections">
        <Switch checked={settings.enabled} onCheckedChange={(enabled) => change({ enabled })}>
          Take tagged sections out of the reply
        </Switch>
        <p className="text-sm text-muted">
          Only at the very start of the reply, after any blank space; several in a row are all taken. Tags later in the
          text stay where they are. Each tag is a regular expression; the default accepts both{" "}
          <code className="font-mono">&lt;think&gt;</code> and <code className="font-mono">&lt;thinking&gt;</code>, so
          either closes either.
        </p>
        <ul className="flex flex-col gap-2">
          {settings.pairs.map((pair, index) => (
            <PairRow
              key={index}
              pair={pair}
              index={index}
              onChange={(next) => setPair(index, next)}
              onRemove={() => change({ pairs: settings.pairs.filter((_, i) => i !== index) })}
            />
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => change({ pairs: [...settings.pairs, { open: "", close: "" }] })}>Add a pair</Button>
          <Button variant="ghost" onClick={() => change({ pairs: [...settings.pairs, DEFAULT_SECTION_PAIR] })}>
            Add the default pair
          </Button>
        </div>
        <Field
          label="Send back on the last replies"
          description="How many of the most recent replies with notes send them back to the model, in their tags. 0: never; the model sees only the reply text."
        >
          <Input
            type="number"
            min={0}
            max={1000}
            step={1}
            className="w-28"
            value={settings.send_back}
            onChange={(event) => {
              const value = Number(event.currentTarget.value)
              if (Number.isInteger(value) && value >= 0 && value <= 1000) change({ send_back: value })
            }}
          />
        </Field>
      </div>
    </Card>
  )
}
