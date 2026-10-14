// Settings → Chats: what applies to all of the user's chats (DESIGN §5.2, §8): the model and
// preset a chat uses when it sets none of its own, and the models and instruction summaries
// use. A chat's own setting takes precedence; its side panel says which one is in effect.
import { GenerationDefaults } from "@rp/shared/generation.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import { useTitle } from "../shell.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { modelValue, parseModelValue, useModelChoices } from "./modelChoices.ts"

const NONE = "none"

export function ChatDefaultsPage() {
  useTitle("Chats")
  const action = useAction()
  const models = useModelChoices(true)
  const [defaults, setDefaults] = useState<GenerationDefaults | null>(null)
  const [presets, setPresets] = useState<ReadonlyArray<LibraryRef>>([])
  const [tail, setTail] = useState("")
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    void action
      .run((client) =>
        Effect.all({
          defaults: client("GetGenerationDefaults", undefined),
          presets: client("ListLibrary", { kind: "preset" })
        })
      )
      .then((result) => {
        if (!result.ok) return
        setDefaults(result.value.defaults)
        setPresets(result.value.presets)
        setTail(result.value.defaults.lcm?.tail ?? "")
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, [])
  const save = (next: GenerationDefaults) =>
    action
      .run((client) => client("SetGenerationDefaults", { defaults: next }))
      .then((result) => {
        if (result.ok) setDefaults(result.value)
        return result.ok
      })
  const items = [{ value: NONE, label: "None" }, ...models]
  const choice = (picked: { connection: string; model: string } | null | undefined) =>
    picked ? modelValue(picked.connection, picked.model) : NONE
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="New chats and chats without their own"
          description="A chat uses these unless it sets its own model or preset, in its side panel's This chat tab."
        />
        <div className="flex flex-col gap-4">
          <Field
            label="Default model"
            description={
              models.length === 0
                ? "Add a connection with models first, in Connections."
                : "Without one, a chat that sets no model can't generate."
            }
          >
            <Select
              items={items}
              value={defaults ? choice(defaults.model) : null}
              placeholder="None"
              onValueChange={(value) =>
                defaults &&
                void save(
                  new GenerationDefaults({ ...defaults, model: value === NONE ? null : parseModelValue(value) })
                )
              }
            />
          </Field>
          <Field
            label="Default preset"
            description="Without one, SillyTavern's built-in default. A connection's own preset takes precedence over this."
          >
            <Select
              items={[
                { value: NONE, label: "SillyTavern's default preset" },
                ...presets.map((ref) => ({ value: ref.id as string, label: ref.label }))
              ]}
              value={defaults ? (defaults.preset ?? NONE) : null}
              placeholder="SillyTavern's default preset"
              onValueChange={(value) =>
                defaults &&
                void save(
                  new GenerationDefaults({
                    ...defaults,
                    preset: value === NONE ? null : (value as LibraryRef["id"])
                  })
                )
              }
            />
          </Field>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Summaries"
          description="For all your chats with summaries on. A chat turns summaries on or off in its side panel."
        />
        <section aria-label="Models for summaries" className="flex flex-col gap-4">
          <Field
            label="Refusal judge"
            description="A model that reads replies and summaries and says whether they are refusals. Without one, only the provider's own refusals are caught."
          >
            <Select
              items={items}
              value={defaults ? choice(defaults.judge) : null}
              placeholder="None"
              onValueChange={(value) =>
                defaults &&
                void save(
                  new GenerationDefaults({ ...defaults, judge: value === NONE ? null : parseModelValue(value) })
                )
              }
            />
          </Field>
          <Field label="Fallback summarizer" description="Tried once when a summary keeps failing on its own model.">
            <Select
              items={items}
              value={defaults ? choice(defaults.lcm?.fallback) : null}
              placeholder="None"
              onValueChange={(value) => {
                if (!defaults) return
                const { fallback: _gone, ...rest } = defaults.lcm ?? {}
                void save(
                  new GenerationDefaults({
                    ...defaults,
                    lcm: value === NONE ? rest : { ...rest, fallback: parseModelValue(value) }
                  })
                )
              }}
            />
          </Field>
          <Field
            label="Summarization instruction"
            description="Your default for all chats. A chat's own instruction takes precedence. Use {{words}} for the summary's word limit; leave empty for the built-in instruction."
          >
            <Textarea
              value={tail}
              onChange={(event) => {
                setTail(event.target.value)
                setSaved(false)
              }}
              rows={5}
              disabled={!defaults}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button
              disabled={!defaults || action.pending}
              onClick={() => {
                if (!defaults) return
                const { tail: _gone, ...rest } = defaults.lcm ?? {}
                void save(new GenerationDefaults({ ...defaults, lcm: tail ? { ...rest, tail } : rest })).then(setSaved)
              }}
            >
              Save summarization instruction
            </Button>
            {saved && (
              <span role="status" className="text-sm text-muted">
                Saved.
              </span>
            )}
          </div>
        </section>
        {action.error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {action.error.message}
          </p>
        )}
      </Card>
    </div>
  )
}
