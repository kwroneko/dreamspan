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
import { Checkbox, Switch } from "../../ui/Choice.tsx"
import { useEffect, useRef, useState } from "react"
import { Field, Input } from "../../ui/Field.tsx"
import { Card } from "../../ui/Surface.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { revealAdded } from "../../ui/reveal.ts"
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
      <div className="flex justify-end">
        <IconButton icon="close" label="Remove this pair" hint="Remove this pair" onClick={onRemove} />
      </div>
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
      </div>
    </li>
  )
}

export function ReplySectionsSettings({ store }: { store: EditorStore }) {
  const stored = useValue<ReplySectionSettings | undefined>(store, PATH)
  const settings = stored ?? DEFAULT_REPLY_SECTIONS
  // What's typed in the number field while it isn't a valid count yet (empty, say).
  const [typed, setTyped] = useState<string | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const added = useRef<number | null>(null)
  useEffect(() => {
    const index = added.current
    added.current = null
    if (index === null) return
    const box = list.current?.children[index]
    if (box instanceof HTMLElement) revealAdded(box)
  }, [settings.pairs])
  // The default pairs this preset doesn't have, as literal tags.
  const missingDefaults = DEFAULT_SECTION_PAIRS.filter(
    (initial) =>
      !settings.pairs.some((pair) => pair.regex !== true && pair.open === initial.open && pair.close === initial.close)
  )
  const change = (next: Partial<ReplySectionSettings>) => store.setValue(PATH, { ...settings, ...next })
  const setPair = (index: number, pair: SectionPair) =>
    change({ pairs: settings.pairs.map((other, i) => (i === index ? pair : other)) })
  const addPairs = (pairs: ReadonlyArray<SectionPair>) => {
    added.current = settings.pairs.length
    change({ pairs: [...settings.pairs, ...pairs] })
  }
  return (
    <Card>
      <div data-preset-section="reply-sections">
        <div className="mb-4 flex items-start gap-2">
          <h2 className="min-w-0 text-base font-semibold">Thinking at the start of a reply</h2>
          <div className="flex shrink-0 gap-2">
            <IconButton
              icon="plus"
              label="Add another tag pair"
              hint="Add another tag pair"
              onClick={() => addPairs([{ open: "", close: "" }])}
            />
            <Menu trigger={<IconButton icon="more" label="Tag pair actions" />} hint="Restore default tag pairs">
              <MenuItem
                disabled={missingDefaults.length === 0}
                description={
                  missingDefaults.length === 0
                    ? "The default tag pairs are already present."
                    : "Adds <think> and </think>"
                }
                onClick={() => addPairs(missingDefaults)}
              >
                Add the default pair
              </MenuItem>
            </Menu>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <ul ref={list} className="flex flex-col gap-2">
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
      </div>
    </Card>
  )
}
