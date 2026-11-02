import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { selectablePresets } from "../pickers/presetList.ts"
import { SlotOutlet } from "../../slots.tsx"
import { accountSettingSections, summarySettingFields } from "./presentation.tsx"
// Settings → Chats: what applies to all of the user's chats (DESIGN §5.2, §8): the model and
// preset a chat uses when it sets none of its own, and the models and instruction summaries
// use. A chat's own setting takes precedence; its side panel says which one is in effect.
//
// Each control writes only its own setting (`ChangeGenerationDefaults`), one write at a time,
// so a change here never puts back what another tab changed since this page read them. The
// instruction is saved by its button; until then userDraft.tsx keeps a server draft,
// undo history, and an unacknowledged browser copy.
import { BUILTIN_PRESET_LABEL, type GenerationDefaults, type GenerationDefaultsChange } from "@rp/shared/generation.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { LCM_BUILTIN, lcmMisfits, resolveLcm } from "@rp/shared/lcmSettings.ts"
import { Effect } from "effect"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { useTitle } from "../shell.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { type Write } from "./LcmFields.tsx"
import { modelValue, parseModelValue, useModelChoices } from "./modelChoices.ts"

const NONE = "none"

const savedTail = (defaults: GenerationDefaults | null) => defaults?.lcm?.tail ?? ""

export function ChatDefaultsPage() {
  useTitle("Chats")
  const action = useAction()
  const [defaults, setDefaults] = useState<GenerationDefaults | null>(null)
  const models = useModelChoices(
    true,
    defaults?.model ? modelValue(defaults.model.connection, defaults.model.model) : null
  )
  const [presets, setPresets] = useState<{ live: ReadonlyArray<LibraryRef>; archived: ReadonlyArray<LibraryRef> }>({
    live: [],
    archived: []
  })
  const instruction = useUserDraft("Settings → Chats", "Summarization instruction", savedTail(defaults))
  const tail = instruction.text
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    void action
      .run((client) =>
        Effect.all({
          defaults: client("GetGenerationDefaults", undefined),
          presets: Effect.all({
            live: client("ListLibrary", { kind: "preset" }),
            archived: client("ListLibrary", { kind: "preset", archived: true })
          })
        })
      )
      .then((result) => {
        if (result.ok) {
          setDefaults(result.value.defaults)
          setPresets(result.value.presets)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Writes run one after another, each naming only its own setting. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const change = (next: GenerationDefaultsChange) => {
    const write = queue.current.then(() =>
      action
        .run((client) => client("ChangeGenerationDefaults", { change: next }), ["settings"])
        .then((result) => {
          if (result.ok) setDefaults(result.value)
          return result.ok
        })
    )
    queue.current = write
    return write
  }
  /** A summarization default, one field at a time; the refusal is shown under that field. */
  const writeLcm: Write = (lcm) => {
    const write = queue.current.then(() =>
      action
        .run((client) => client("ChangeGenerationDefaults", { change: { lcm } }), ["settings"])
        .then((result) => {
          if (result.ok) setDefaults(result.value)
          return result.ok ? null : result.error.message
        })
    )
    queue.current = write
    return write
  }

  const type = (text: string) => {
    instruction.setText(text)
    setSaved(false)
  }
  const saveTail = async () => {
    const text = instruction.text
    setSaved(await instruction.commit(text, () => change({ tail: text === "" ? null : text })))
  }

  const items = [{ value: NONE, label: "None" }, ...models]
  const choice = (picked: { connection: string; model: string } | null | undefined) =>
    picked ? modelValue(picked.connection, picked.model) : NONE
  const unsaved = defaults !== null && tail !== savedTail(defaults)
  const account = resolveLcm(null, defaults?.lcm)
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Replies" />
        <div className="flex flex-col gap-4">
          <Field
            label="Default model"
            description={
              models.length === 0 ? (
                <>
                  Add a connection with models first, in{" "}
                  <Link to="/settings/connections" className="text-accent underline-offset-4 hover:underline">
                    Connections
                  </Link>
                  .
                </>
              ) : undefined
            }
          >
            <Select
              items={items}
              value={defaults ? choice(defaults.model) : null}
              placeholder="None"
              onValueChange={(value) => void change({ model: value === NONE ? null : parseModelValue(value) })}
            />
          </Field>
          <Field
            label="Default preset"
            about="Choose how prompts are written. Empty uses the built-in preset. A connection may select its own preset."
          >
            <Select
              items={[
                { value: NONE, label: BUILTIN_PRESET_LABEL },
                ...selectablePresets(presets.live, presets.archived, defaults?.preset ?? null)
              ]}
              value={defaults ? (defaults.preset ?? NONE) : null}
              placeholder={BUILTIN_PRESET_LABEL}
              onValueChange={(value) => void change({ preset: value === NONE ? null : (value as LibraryRef["id"]) })}
            />
          </Field>
          <Field
            label="Refusal judge"
            about="Detect refusals in replies and summaries with this model. None catches only refusals reported by the provider."
          >
            <Select
              items={items}
              value={defaults ? choice(defaults.judge) : null}
              placeholder="None"
              onValueChange={(value) => void change({ judge: value === NONE ? null : parseModelValue(value) })}
            />
          </Field>
        </div>
      </Card>
      <SlotOutlet
        slot={accountSettingSections}
        props={{
          instructionDraft: instruction,
          defaults,
          items,
          account,
          change,
          writeLcm,
          tail,
          type,
          unsaved,
          saved,
          saveTail,
          pending: action.pending,
          error: action.error
        }}
      />
    </div>
  )
}

export interface SummaryDefaultsProps {
  instructionDraft: ReturnType<typeof useUserDraft>
  defaults: GenerationDefaults | null
  items: ReturnType<typeof useModelChoices>
  account: ReturnType<typeof resolveLcm>
  change: (change: GenerationDefaultsChange) => Promise<boolean>
  writeLcm: Write
  tail: string
  type: (text: string) => void
  unsaved: boolean
  saved: boolean
  saveTail: () => Promise<void>
  pending: boolean
  error: import("../../errors.ts").AppError | null
}
export function SummaryDefaults({
  instructionDraft,
  defaults,
  items,
  account,
  change,
  writeLcm,
  tail,
  type,
  unsaved,
  saved,
  saveTail,
  pending,
  error
}: SummaryDefaultsProps) {
  const choice = (picked: { connection: string; model: string } | null | undefined) =>
    picked ? modelValue(picked.connection, picked.model) : NONE
  return (
    <Card>
      <CardHeader title="Summaries" />
      <section aria-label="Models for summaries" className="flex flex-col gap-4">
        <Field label="Fallback summarizer" about="Tried once when a summary keeps failing on its own model.">
          <Select
            items={items}
            value={defaults ? choice(defaults.lcm?.fallback) : null}
            placeholder="None"
            onValueChange={(value) => void change({ fallback: value === NONE ? null : parseModelValue(value) })}
          />
        </Field>
        <Switch
          checked={account.enabled}
          disabled={!defaults}
          onCheckedChange={(enabled) => void writeLcm({ enabled })}
          about="Keep the story in context as new chats grow. Imported chats start with summaries off."
        >
          New chats summarize older messages
        </Switch>
        <Field
          label="Summarization instruction"
          about="What new chats ask for when summarizing. {{words}} is the summary's length; empty uses the built-in instruction."
        >
          <Textarea
            textActions
            value={tail}
            onChange={(event) => type(event.target.value)}
            rows={5}
            disabled={!defaults}
          />
        </Field>
        <UserDraftNotices draft={instructionDraft} />
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!defaults || pending || !unsaved} onClick={() => void saveTail()}>
            Save summarization instruction
          </Button>
          <UserDraftUndo draft={instructionDraft} />
          {saved && !unsaved ? (
            <span role="status" className="text-sm text-muted">
              Saved.
            </span>
          ) : (
            unsaved && (
              <span role="status" className="text-sm text-muted">
                Not saved yet. Your draft is kept.
              </span>
            )
          )}
        </div>
      </section>
      <section aria-label="Summary defaults for new chats" className="mt-6 flex flex-col gap-3">
        <h3 className="text-sm font-medium text-text">For new chats</h3>
        <SlotOutlet
          slot={summarySettingFields}
          props={{
            scope: "account",
            view: { resolved: account, fit: lcmMisfits(account, null), now: null, fitted: null },
            fallback: LCM_BUILTIN,
            write: writeLcm,
            disabled: !defaults
          }}
        />
      </section>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error.message}
        </p>
      )}
    </Card>
  )
}
