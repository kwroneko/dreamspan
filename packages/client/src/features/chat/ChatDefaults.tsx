// Settings → Chats: what applies to all of the user's chats (DESIGN §5.2, §8): the model and
// preset a chat uses when it sets none of its own, and the models and instruction summaries
// use. A chat's own setting takes precedence; its side panel says which one is in effect.
//
// Each control writes only its own setting (`ChangeGenerationDefaults`), one write at a time,
// so a change here never puts back what another tab changed since this page read them. The
// instruction is saved by its button; until then what's typed is copied into this browser
// (`editor/backup.ts`), shown again here after leaving the page or a reload, and listed in
// Browser recovery.
import { BUILTIN_PRESET_LABEL, type GenerationDefaults, type GenerationDefaultsChange } from "@rp/shared/generation.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { useEffect, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { useTitle } from "../shell.tsx"
import { Button } from "../../ui/Button.tsx"
import { Field, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { type Copy, copiesOf, dropCopy, keepCopy, makeCopy, pendingOf } from "../editor/backup.ts"
import { modelValue, parseModelValue, useModelChoices } from "./modelChoices.ts"

const NONE = "none"

/** Where the instruction's browser copies are filed, as Browser recovery names them. */
const INSTRUCTION = { refId: "Settings → Chats", field: "Summarization instruction" } as const

const savedTail = (defaults: GenerationDefaults | null) => defaults?.lcm?.tail ?? ""

export function ChatDefaultsPage() {
  useTitle("Chats")
  const action = useAction()
  const userId = useSession().user.id
  const models = useModelChoices(true)
  const [defaults, setDefaults] = useState<GenerationDefaults | null>(null)
  const [presets, setPresets] = useState<ReadonlyArray<LibraryRef>>([])
  const [tail, setTail] = useState("")
  const [saved, setSaved] = useState(false)
  /** The instruction typed and not saved, as kept in this browser. */
  const copy = useRef<Copy | null>(null)
  const [restored, setRestored] = useState(false)
  useEffect(() => {
    let live = true
    void Promise.all([
      action.run((client) =>
        Effect.all({
          defaults: client("GetGenerationDefaults", undefined),
          presets: client("ListLibrary", { kind: "preset" })
        })
      ),
      copiesOf(userId, INSTRUCTION.refId)
    ]).then(([result, copies]) => {
      if (!live || !result.ok) return
      setDefaults(result.value.defaults)
      setPresets(result.value.presets)
      // The newest text typed here and not saved, else the saved instruction.
      let kept: Copy | undefined = copies
        .filter((c) => c.field === INSTRUCTION.field && pendingOf(c)?.kind === "setting")
        .sort((a, b) => b.at - a.at)[0]
      // Saved since, from another tab: nothing is left to keep.
      if (kept !== undefined && kept.content === savedTail(result.value.defaults)) {
        void dropCopy(kept)
        kept = undefined
      }
      copy.current = kept ?? null
      setRestored(kept !== undefined)
      setTail(kept?.content ?? savedTail(result.value.defaults))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, [userId])

  /** Writes run one after another, each naming only its own setting. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const change = (next: GenerationDefaultsChange) => {
    const write = queue.current.then(() =>
      action
        .run((client) => client("ChangeGenerationDefaults", { change: next }))
        .then((result) => {
          if (result.ok) setDefaults(result.value)
          return result.ok
        })
    )
    queue.current = write
    return write
  }

  /** Saves of the instruction not answered yet: until they are, what's saved may still change. */
  const saving = useRef(0)

  /**
   * Keeps the instruction typed in this browser, or drops the copy once it matches what's
   * saved. While a save is in flight the saved value is about to change, so the copy stays.
   */
  const type = (text: string) => {
    setTail(text)
    setSaved(false)
    const previous = copy.current
    if (text === savedTail(defaults) && saving.current === 0) {
      copy.current = null
      if (previous !== null) void dropCopy(previous)
      return
    }
    const next = makeCopy(
      userId,
      INSTRUCTION.refId,
      INSTRUCTION.field,
      { kind: "setting", payload: { content: text } },
      Date.now(),
      previous === null ? [] : [previous]
    )
    copy.current = next
    void keepCopy(next, previous)
  }

  const saveTail = async () => {
    const sent = tail
    const kept = copy.current
    saving.current += 1
    const ok = await change({ tail: sent === "" ? null : sent }).finally(() => {
      saving.current -= 1
    })
    // What was saved is on the server: its copy goes, unless more was typed since.
    if (ok && kept !== null && copy.current === kept) {
      copy.current = null
      setRestored(false)
      void dropCopy(kept)
    }
    setSaved(ok)
  }

  const items = [{ value: NONE, label: "None" }, ...models]
  const choice = (picked: { connection: string; model: string } | null | undefined) =>
    picked ? modelValue(picked.connection, picked.model) : NONE
  const unsaved = defaults !== null && tail !== savedTail(defaults)
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Current model and prompt preset"
          description="These account settings apply to every chat. You can also switch them in the composer."
        />
        <div className="flex flex-col gap-4">
          <Field
            label="Default model"
            description={
              models.length === 0
                ? "Add a connection with models first, in Connections."
                : "Choose a model to generate replies."
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
            description="Without one, the built-in prompt preset is used. Switching connections may select a locked preset."
          >
            <Select
              items={[
                { value: NONE, label: BUILTIN_PRESET_LABEL },
                ...presets.map((ref) => ({ value: ref.id as string, label: ref.label }))
              ]}
              value={defaults ? (defaults.preset ?? NONE) : null}
              placeholder={BUILTIN_PRESET_LABEL}
              onValueChange={(value) => void change({ preset: value === NONE ? null : (value as LibraryRef["id"]) })}
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
              onValueChange={(value) => void change({ judge: value === NONE ? null : parseModelValue(value) })}
            />
          </Field>
          <Field label="Fallback summarizer" description="Tried once when a summary keeps failing on its own model.">
            <Select
              items={items}
              value={defaults ? choice(defaults.lcm?.fallback) : null}
              placeholder="None"
              onValueChange={(value) => void change({ fallback: value === NONE ? null : parseModelValue(value) })}
            />
          </Field>
          <Field
            label="Summarization instruction"
            description="Your default for all chats. A chat's own instruction takes precedence. Use {{words}} for the summary's word limit; leave empty for the built-in instruction."
          >
            <Textarea value={tail} onChange={(event) => type(event.target.value)} rows={5} disabled={!defaults} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!defaults || action.pending || !unsaved} onClick={() => void saveTail()}>
              Save summarization instruction
            </Button>
            {saved && !unsaved ? (
              <span role="status" className="text-sm text-muted">
                Saved.
              </span>
            ) : (
              unsaved && (
                <span role="status" className="text-sm text-muted">
                  {restored ? "Typed earlier and not saved yet" : "Not saved yet"}: kept in this browser until you save
                  it.
                </span>
              )
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
