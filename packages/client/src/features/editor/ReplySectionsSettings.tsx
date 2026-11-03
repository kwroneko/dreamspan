// Tagged sections at the start of a reply (spec/REPLY-SECTIONS.md): which opening and closing
// tags take a leading section out of the reply into its own panel, whether that's on, and
// how many recent replies send theirs back. Tags are text matched as written, as SillyTavern's
// prefix and suffix are; a pair is a regular expression only when "Treat as a regex" is on
// (owner, 2026-11-02). The whole setting is one field of the preset; absent, the defaults show
// and the first change writes them out.
import {
  DEFAULT_REPLY_SECTIONS,
  DEFAULT_SECTION_PAIRS,
  type ReplySectionSettings,
  type SectionPair
} from "@rp/shared/replySections.ts"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { useState } from "react"
import { Field, Input } from "../../ui/Field.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { type EditorStore, useValue } from "./store.ts"

const PATH = ["reply_sections"]

/**
 * Why a tag can't be used: empty, or (a regex pair) a pattern the browser can't read; the
 * server also skips what its linear-time engine can't run.
 */
const tagError = (tag: string, regex: boolean) => {
  if (tag === "") return "Empty: this pair is skipped."
  if (!regex) return null
  try {
    new RegExp(tag)
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
  const regex = pair.regex === true
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3" data-section-pair={index}>
      <div className="grid w-full max-w-controls grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2">
        <Field
          label="Opening tag"
          about={
            regex ? "Where a section starts: a regular expression." : "Where a section starts, exactly as written."
          }
          error={tagError(pair.open, regex)}
        >
          <Input
            value={pair.open}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => onChange({ ...pair, open: event.currentTarget.value })}
          />
        </Field>
        <Field
          label="Closing tag"
          about={regex ? "Where it ends: a regular expression." : "Where it ends, exactly as written."}
          error={tagError(pair.close, regex)}
        >
          <Input
            value={pair.close}
            spellCheck={false}
            className="font-mono"
            onChange={(event) => onChange({ ...pair, close: event.currentTarget.value })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Checkbox
            about="On: the tags match only in the case written. Off: any case, so <THINK> too."
            checked={pair.case_sensitive === true}
            onCheckedChange={(checked) => {
              const { case_sensitive: _, ...rest } = pair
              onChange(checked ? { ...rest, case_sensitive: true } : rest)
            }}
          >
            Match case
          </Checkbox>
          <Checkbox
            about="On: both tags are regular expressions, so <think(?:ing)?> matches either spelling (no lookaheads or backreferences). Off: they match exactly as written, symbols like | . * [ included."
            checked={regex}
            onCheckedChange={(checked) => {
              const { regex: _, ...rest } = pair
              onChange(checked ? { ...rest, regex: true } : rest)
            }}
          >
            Treat as a regex
          </Checkbox>
        </div>
        <Button variant="ghost" hint="These tags no longer mark thinking." onClick={onRemove}>
          Remove pair
        </Button>
      </div>
    </li>
  )
}

export function ReplySectionsSettings({ store }: { store: EditorStore }) {
  const stored = useValue<ReplySectionSettings | undefined>(store, PATH)
  const settings = stored ?? DEFAULT_REPLY_SECTIONS
  // What's typed in the number field while it isn't a valid count yet (empty, say).
  const [typed, setTyped] = useState<string | null>(null)
  // The default pairs this preset doesn't have, as literal tags.
  const missingDefaults = DEFAULT_SECTION_PAIRS.filter(
    (initial) =>
      !settings.pairs.some((pair) => pair.regex !== true && pair.open === initial.open && pair.close === initial.close)
  )
  const change = (next: Partial<ReplySectionSettings>) => store.setValue(PATH, { ...settings, ...next })
  const setPair = (index: number, pair: SectionPair) =>
    change({ pairs: settings.pairs.map((other, i) => (i === index ? pair : other)) })
  return (
    <Card>
      <CardHeader title="Thinking at the start of a reply" />
      <div className="flex flex-col gap-4" data-preset-section="reply-sections">
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
          <Button
            hint="Another opening and closing tag that mark thinking."
            onClick={() => change({ pairs: [...settings.pairs, { open: "", close: "" }] })}
          >
            Add a pair
          </Button>
          {missingDefaults.length > 0 && (
            <Button
              variant="ghost"
              hint={`Adds back ${missingDefaults.map((pair) => `${pair.open} … ${pair.close}`).join(" and ")}, matched as written.`}
              onClick={() => change({ pairs: [...settings.pairs, ...missingDefaults] })}
            >
              {missingDefaults.length > 1 ? "Add the default pairs" : "Add the default pair"}
            </Button>
          )}
        </div>
        <Switch
          checked={settings.enabled}
          about="Keep tagged thinking separate from the reply. Only tags at the start count; tags later in the reply stay as written. Several thinking sections at the start all move. Off keeps thinking in the reply text."
          onCheckedChange={(enabled) => change({ enabled })}
        >
          Move tagged thinking into its own panel
        </Switch>
        <Field
          label="Send thinking back for the last replies"
          about="How many of the most recent replies with thinking send it back to the model, in its tags. 0: never; the model sees only the reply text."
        >
          <Input
            type="number"
            min={0}
            max={1000}
            step={1}
            inputMode="numeric"
            className="max-w-28"
            value={typed ?? String(settings.send_back)}
            onChange={(event) => {
              const text = event.currentTarget.value
              setTyped(text)
              const value = Number(text)
              if (text.trim() !== "" && Number.isInteger(value) && value >= 0 && value <= 1000)
                change({ send_back: value })
            }}
            onBlur={() => setTyped(null)}
          />
        </Field>
      </div>
    </Card>
  )
}
