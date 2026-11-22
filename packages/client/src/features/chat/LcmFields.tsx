import { useDurableText, useOpenPlace } from "../editor/durable.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
// The summarization settings (DESIGN §8), shared by the side panel's This chat tab (a chat's own,
// each falling back to the account default) and Settings → Chats (the account default for new
// chats, each falling back to the built-in). Each field is one write: a number when it's left or
// Enter is pressed, a choice when it's picked. The pairs and the fit problems are measured by
// the server; this only shows them under the fields they are about.
import {
  LCM_BUILTIN,
  type LcmField,
  type LcmSettingsChange,
  type LcmWhen,
  chunkSize,
  loweredTarget,
  summaryPreset,
  type SummaryPreset,
  summaryWords
} from "@dreamspan/shared/lcmSettings.ts"
import type { LcmSettingsView } from "@dreamspan/shared/lcm.ts"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Field, Fieldset, Input } from "../../ui/Field.tsx"
import type { RefId } from "@dreamspan/shared/library.ts"
import { usePresetSelection } from "../pickers/presetSelection.ts"
import { PresetPickerPopover } from "../pickers/PresetPicker.tsx"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { Segmented } from "../../ui/Segmented.tsx"

type Resolved = LcmSettingsView["resolved"]
type Misfit = LcmSettingsView["fit"][number]
type Source = "chat" | "account" | "builtin"

const tokens = (n: number) => n.toLocaleString("en-US")

/** What Reset does: a chat's own value goes, or the user's default does. */
const resetHint = (scope: "chat" | "account") =>
  scope === "chat"
    ? "Drops this chat's own value: it follows the account default again."
    : "Drops your default: chats that follow it use the built-in value."

/** What a write answers: null when it was taken, else the reason to show under the field. */
export type Write = (change: LcmSettingsChange) => Promise<string | null>

/**
 * Where a field's value comes from and the way back to what it would follow. A chat copies the
 * account default when it's made, so a value of its own that matches the default says so.
 */
function Origin({
  scope,
  from,
  same,
  fallback,
  onReset,
  disabled
}: {
  scope: "chat" | "account"
  from: Source
  /** The value equals what it would follow. */
  same: boolean
  fallback: string
  onReset: () => void
  disabled: boolean
}) {
  const own = scope === "chat" ? from === "chat" : from === "account"
  const other = scope === "chat" ? "account default" : "built-in"
  // On the account page the built-in is the natural state: only a value of the user's says where it's from.
  if (!own) return scope === "chat" ? <span className="text-xs text-muted">Follows the {other}.</span> : null
  if (same) return <span className="text-xs text-muted">Same as the {other}.</span>
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
      <span>
        {scope === "chat" ? "This chat's own" : "Your default"}; the {other} is {fallback}.
      </span>
      <Button
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={disabled}
        hint={resetHint(scope)}
        onClick={onReset}
      >
        Reset to {other}
      </Button>
    </span>
  )
}

/**
 * A number of tokens, written when the field is left or Enter is pressed. `optional` takes an
 * empty field as "automatic" (null).
 */
function TokensInput({
  place,
  label,
  value,
  onCommit,
  disabled,
  invalid,
  optional = false,
  about
}: {
  /** The settings it's in ("chat:<id>", "account"): the key what's typed is kept under, with the label. */
  place: string
  label: string
  value: number | null
  onCommit: (value: number | null) => Promise<string | null>
  disabled: boolean
  invalid: boolean
  optional?: boolean
  about?: string
}) {
  // Kept as typed until it's written; until then a new value from the server shows.
  const typed = useDurableText(`lcm:${place}`, label, value === null ? "" : String(value))
  const text = typed.text
  const [problem, setProblem] = useState<string | null>(null)
  const written = (next: string | null) => {
    setProblem(next)
    if (next === null) void typed.commit(async () => true)
  }
  const commit = async () => {
    const trimmed = text.replace(/[,\s_]/g, "")
    if (trimmed === "" && optional) return written(value !== null ? await onCommit(null) : null)
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) return setProblem("A whole number of tokens, above 0.")
    if (n === value) return written(null)
    written(await onCommit(n))
  }
  return (
    <Field label={label} about={about} error={problem} className="w-36">
      <Input
        inputMode="numeric"
        value={text}
        disabled={disabled}
        placeholder={optional ? "Automatic" : undefined}
        aria-invalid={invalid || problem !== null || undefined}
        readOnly={!typed.ready}
        onValueChange={typed.setText}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit()
        }}
      />
    </Field>
  )
}

function Problems({ misfits }: { misfits: ReadonlyArray<Misfit> }) {
  return misfits.length ? (
    <div role="alert" className="flex flex-col gap-1">
      {misfits.map((m) => (
        <p key={m.message} className="text-sm text-danger">
          {m.message}
        </p>
      ))}
    </div>
  ) : null
}

/** Where a pair comes from, in one line: both following, both copied unchanged, or the chat's own. */
function PairOrigin({
  scope,
  resolved,
  target,
  maximum,
  fallback,
  disabled,
  onReset
}: {
  scope: "chat" | "account"
  resolved: Resolved
  target: "recentTarget" | "layerTarget"
  maximum: "recentMax" | "layerMax"
  fallback: readonly [number, number]
  disabled: boolean
  onReset: () => Promise<unknown>
}) {
  const ownSource = scope === "chat" ? "chat" : "account"
  const own = resolved.from[target] === ownSource || resolved.from[maximum] === ownSource
  const other = scope === "chat" ? "account default" : "built-in"
  if (!own) return scope === "chat" ? <span className="text-xs text-muted">Follows the {other}.</span> : null
  if (resolved[target] === fallback[0] && resolved[maximum] === fallback[1])
    return <span className="text-xs text-muted">Same as the {other}.</span>
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
      <span>
        {scope === "chat" ? "This chat's own" : "Your default"}; the {other} is {tokens(fallback[0])} and{" "}
        {tokens(fallback[1])}.
      </span>
      <Button
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={disabled}
        hint={resetHint(scope)}
        onClick={() => void onReset()}
      >
        Reset to {other}
      </Button>
    </span>
  )
}

/** A target and a maximum, with the figure the next context has now. */
function Pair({
  place,
  legend,
  about,
  scope,
  resolved,
  fallback,
  target,
  maximum,
  now,
  scaled,
  pendingSummary = false,
  misfits,
  write,
  disabled
}: {
  place: string
  legend: string
  about: string
  scope: "chat" | "account"
  resolved: Resolved
  fallback: Partial<Record<LcmField, unknown>>
  target: "recentTarget" | "layerTarget"
  maximum: "recentMax" | "layerMax"
  now: number | null
  scaled: { target: number; maximum: number; clamped: boolean } | null
  pendingSummary?: boolean
  misfits: ReadonlyArray<Misfit>
  write: Write
  disabled: boolean
}) {
  const shown = misfits.filter((m) => m.field === target || m.field === maximum)
  // A maximum lowered to the target or below takes the target with it, and says so.
  const [lowered, setLowered] = useState<number | null>(null)
  // A value just saved, until the settings are read again: a maximum entered right after a
  // target is compared with that target, not the one shown before it.
  const saved = useRef<Partial<Record<string, { value: number; was: number }>>>({})
  // Once the settings are read again the shown value is current: forget the saved one, so a later
  // change by another control (Reset) that returns to the old value doesn't revive it.
  const shownTarget = resolved[target],
    shownMaximum = resolved[maximum]
  useEffect(() => {
    for (const [field, shownValue] of [
      [target, shownTarget],
      [maximum, shownMaximum]
    ] as const) {
      const own = saved.current[field]
      if (own && shownValue !== own.was) delete saved.current[field]
    }
  }, [target, maximum, shownTarget, shownMaximum])
  const latest = (field: typeof target | typeof maximum) => {
    const own = saved.current[field]
    return own && resolved[field] === own.was ? own.value : resolved[field]
  }
  const commit = async (field: typeof target | typeof maximum, value: number | null) => {
    const below = field === maximum && value !== null ? loweredTarget(latest(target), latest(field), value) : null
    const prior = { ...saved.current }
    if (value !== null) saved.current[field] = { value, was: resolved[field] }
    if (below !== null) saved.current[target] = { value: below, was: resolved[target] }
    const problem = await write(below === null ? { [field]: value } : { [field]: value, [target]: below })
    if (problem !== null) saved.current = prior
    setLowered(problem === null ? below : null)
    return problem
  }
  return (
    <Fieldset legend={legend} about={about}>
      <div className="flex flex-wrap items-end gap-3">
        {([target, maximum] as const).map((field) => (
          <TokensInput
            place={`${place}:${field}`}
            key={field}
            label={field === target ? "Target" : "Maximum"}
            value={resolved[field]}
            disabled={disabled}
            invalid={shown.length > 0}
            onCommit={(value) => commit(field, value)}
          />
        ))}
        {now !== null && (
          <p className="pb-2 text-sm text-muted" aria-label={`${legend} now`}>
            now {tokens(now)}
          </p>
        )}
      </div>
      {pendingSummary && (
        <p className="text-sm text-muted" role="status">
          Summary pending for the next reply. It will send summaries of older messages and tool steps, then the recent
          text. A single message or unread tool result may still exceed the maximum.
        </p>
      )}
      {lowered !== null && resolved[target] === lowered && (
        <p role="status" className="text-sm text-muted">
          Target lowered to {tokens(lowered)} to stay below the maximum.
        </p>
      )}
      {scaled?.clamped && (
        <p className="text-sm text-muted">
          Scaled down with the summary block to fit this model: target {tokens(scaled.target)}, maximum{" "}
          {tokens(scaled.maximum)}.
        </p>
      )}
      <PairOrigin
        scope={scope}
        resolved={resolved}
        target={target}
        maximum={maximum}
        fallback={[Number(fallback[target] ?? LCM_BUILTIN[target]), Number(fallback[maximum] ?? LCM_BUILTIN[maximum])]}
        disabled={disabled}
        onReset={async () => {
          await write({ [target]: null })
          await write({ [maximum]: null })
        }}
      />
      <Problems misfits={shown} />
    </Fieldset>
  )
}

/**
 * The fields other than the switch and the instruction: how the request is sent, the two pairs,
 * when it runs, and under Advanced the chunk size and summary length.
 */
export function LcmFields({
  place,
  scope,
  view,
  fallback,
  write,
  disabled,
  instruction,
  transcriptOnly = false
}: {
  /** Whose settings ("chat:<id>", "account"): what's typed in its number fields is kept under it. */
  place: string
  scope: "chat" | "account"
  /** The settings as they resolve, the fit and the figures (an account default has no figures). */
  view: Pick<LcmSettingsView, "resolved" | "fit" | "now" | "fitted">
  /** What each field falls back to: the account default for a chat, the built-in for the account. */
  fallback: Partial<Record<LcmField, unknown>>
  write: Write
  disabled: boolean
  /** The instruction's editor, placed after how the request is sent. */
  instruction?: ReactNode
  /** This kind always summarizes its own conversation and tool steps, without a preset or notes. */
  transcriptOnly?: boolean
}) {
  const { resolved, fit, now, fitted } = view
  // Advanced open is URL state: a reload shows its fields again, with what was typed in them.
  const [advanced, setAdvanced] = useOpenPlace(`lcm-advanced:${place}`)
  const presets = usePresetSelection(null)
  const workspace = usePresetWorkspace()
  const specific = resolved.withPreset === "specific"
  const chosen = resolved.preset
  const current = [...presets.live, ...presets.archived].find((ref) => ref.id === chosen) ?? null
  const unavailable = specific && presets.loaded && chosen !== null && (!current || current.archivedAt !== null)
  const fallbackPreset = summaryPreset((fallback.withPreset ?? LCM_BUILTIN.withPreset) as SummaryPreset | boolean)
  const presetLabel = (value: SummaryPreset) =>
    value === "specific"
      ? ([...presets.live, ...presets.archived].find((ref) => ref.id === fallback.preset)?.label ?? "a specific preset")
      : value === "current"
        ? "the current preset"
        : "instruction and messages only"
  const [problem, setProblem] = useState<{ field: LcmField; message: string } | null>(null)
  const choose = async (change: LcmSettingsChange) => {
    const field = Object.keys(change)[0] as LcmField
    const message = await write(change)
    setProblem(message === null ? null : { field, message })
    return message
  }
  const errorFor = (field: LcmField) => (problem?.field === field ? problem.message : null)
  const chunk =
    fitted?.chunk ?? chunkSize(resolved.leafInput, { target: resolved.recentTarget, maximum: resolved.recentMax })
  return (
    <div className="flex flex-col gap-5">
      <Fieldset legend="Send with">
        {transcriptOnly ? (
          <Tooltip label="Presets and notes aren’t sent to the summary model.">
            <p tabIndex={0} className="text-sm text-muted">
              This workshop’s messages and tool steps only.
            </p>
          </Tooltip>
        ) : (
          <>
            <Segmented
              label="Send with"
              wrap
              value={resolved.withPreset}
              onValueChange={(value) => void choose({ withPreset: value })}
              options={[
                {
                  value: "current",
                  label: "The current preset",
                  description: "Summary requests use your current preset, so they can reuse the chat's cached prompt."
                },
                {
                  value: "specific",
                  label: "A specific preset",
                  description:
                    "Summary requests use this preset. Its prompt differs from the chat's, so the chat's cached prompt can't be reused."
                },
                {
                  value: "raw",
                  label: "Instruction and messages only",
                  description: "Only the instruction, the earlier summaries and the messages."
                }
              ]}
            />
            {specific && (
              <div className="flex min-w-0 items-center gap-2">
                <PresetPickerPopover
                  place="summary"
                  selection={{
                    ...presets,
                    usage: "summary",
                    value: chosen ?? "",
                    current,
                    label: current?.label ?? "Choose a preset",
                    choose: async (value) => (await choose({ withPreset: "specific", preset: value as RefId })) === null
                  }}
                  side="bottom"
                  triggerLabel="Preset for summaries"
                  hint="Choose the preset summary requests use."
                  triggerClassName="flex h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm text-text hover:bg-surface-raised"
                  trigger={
                    <>
                      <span data-layout-name className="min-w-0 truncate">
                        {current?.label ?? "Choose a preset"}
                      </span>
                      <Icon name="down" size={14} />
                    </>
                  }
                />
                <IconButton
                  label="Open this preset in the large editor"
                  hint={
                    chosen && !unavailable
                      ? "Open this preset in the large editor"
                      : "Choose an available preset to open in the large editor"
                  }
                  icon="expand"
                  disabled={disabled || !chosen || unavailable}
                  onClick={() => {
                    if (chosen) workspace?.open(chosen)
                  }}
                />
              </div>
            )}
            {unavailable && (
              <p role="status" className="text-sm text-warning">
                The chosen preset is no longer available; summaries use your current preset.
              </p>
            )}
            <Origin
              scope={scope}
              from={resolved.from.withPreset ?? "builtin"}
              same={
                resolved.withPreset === fallbackPreset && (!specific || resolved.preset === (fallback.preset ?? null))
              }
              fallback={presetLabel(fallbackPreset)}
              disabled={disabled}
              onReset={() => void choose({ withPreset: null, preset: null })}
            />
            {errorFor("withPreset") && <p className="text-sm text-danger">{errorFor("withPreset")}</p>}
            <Switch
              checked={resolved.withNotes}
              disabled={disabled}
              onCheckedChange={(withNotes) => void choose({ withNotes })}
              about="Send the chat’s notes when summarizing too. Leave off if they describe events after the messages being summarized."
            >
              Include notes in summary requests
            </Switch>
            <Origin
              scope={scope}
              from={resolved.from.withNotes ?? "builtin"}
              same={resolved.withNotes === (fallback.withNotes ?? LCM_BUILTIN.withNotes)}
              fallback={(fallback.withNotes ?? LCM_BUILTIN.withNotes) ? "on" : "off"}
              disabled={disabled}
              onReset={() => void choose({ withNotes: null })}
            />
            {errorFor("withNotes") && <p className="text-sm text-danger">{errorFor("withNotes")}</p>}
          </>
        )}
      </Fieldset>
      {instruction}
      <Pair
        place={place}
        legend="Recent messages kept as written"
        about="Keep recent messages as written up to the maximum: past it, the oldest are summarized until the recent part is back at the target."
        scope={scope}
        resolved={resolved}
        fallback={fallback}
        target="recentTarget"
        maximum="recentMax"
        now={now?.recent ?? null}
        pendingSummary={
          transcriptOnly &&
          resolved.enabled &&
          now !== null &&
          now.recent > (fitted?.recent.maximum ?? resolved.recentMax)
        }
        scaled={fitted?.recent ?? null}
        misfits={fit}
        write={write}
        disabled={disabled}
      />
      <Pair
        place={place}
        legend="Summary block"
        about="Keep the summaries within the maximum: past it, the oldest are condensed until the block is back at the target."
        scope={scope}
        resolved={resolved}
        fallback={fallback}
        target="layerTarget"
        maximum="layerMax"
        now={now?.layer ?? null}
        scaled={null}
        misfits={fit}
        write={write}
        disabled={disabled}
      />
      <Fieldset legend="Written as">
        <Segmented
          label="Written as"
          wrap
          value={resolved.style}
          onValueChange={(style) => void choose({ style })}
          options={[
            {
              value: "direct",
              label: "A reply",
              description: "The model's reply is the summary. Works with every model."
            },
            {
              value: "tool",
              label: "With tools",
              description: "The model writes the summary through a tool. Needs a model that can call tools."
            }
          ]}
        />
        <Origin
          scope={scope}
          from={resolved.from.style ?? "builtin"}
          same={resolved.style === (fallback.style ?? LCM_BUILTIN.style)}
          fallback={(fallback.style ?? LCM_BUILTIN.style) === "tool" ? "with tools" : "a reply"}
          disabled={disabled}
          onReset={() => void choose({ style: null })}
        />
        {errorFor("style") && <p className="text-sm text-danger">{errorFor("style")}</p>}
      </Fieldset>
      <Fieldset legend="When it runs">
        <RadioGroup<LcmWhen>
          value={resolved.when}
          onValueChange={(when) => void choose({ when })}
          options={[
            {
              value: "after-reply",
              label: "Right after a reply",
              description: "Right after a reply, while its cache is still cheap to read."
            },
            {
              value: "next-reply",
              label: "With the next reply",
              description: "Nothing is sent until you send again."
            }
          ]}
        />
        <Origin
          scope={scope}
          from={resolved.from.when ?? "builtin"}
          same={resolved.when === (fallback.when ?? LCM_BUILTIN.when)}
          fallback={
            (fallback.when ?? LCM_BUILTIN.when) === "next-reply" ? "with the next reply" : "right after a reply"
          }
          disabled={disabled}
          onReset={() => void choose({ when: null })}
        />
        {errorFor("when") && <p className="text-sm text-danger">{errorFor("when")}</p>}
      </Fieldset>
      <details className="group" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <Tooltip label="Shows chunk size and summary length settings.">
          <summary className="cursor-pointer text-sm font-medium text-text">Advanced</summary>
        </Tooltip>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <TokensInput
              place={place}
              label="Chunk size"
              about="Choose how many tokens of messages one summary covers. Empty chooses automatically."
              value={resolved.leafInput}
              optional
              disabled={disabled}
              invalid={fit.some((m) => m.field === "leafInput")}
              onCommit={(value) => write({ leafInput: value })}
            />
            <p className="text-sm text-muted">Chunk size now: {tokens(chunk)} tokens.</p>
            <Origin
              scope={scope}
              from={resolved.from.leafInput ?? "builtin"}
              same={resolved.leafInput === (fallback.leafInput ?? null)}
              fallback={fallback.leafInput == null ? "automatic" : tokens(Number(fallback.leafInput))}
              disabled={disabled}
              onReset={() => void write({ leafInput: null })}
            />
            <Problems misfits={fit.filter((m) => m.field === "leafInput")} />
          </div>
          <div className="flex flex-col gap-1">
            <TokensInput
              place={place}
              label="Summary length"
              about="Choose the length to ask for, in tokens. The instruction uses an approximate word count through {{words}}."
              value={resolved.leafTarget}
              disabled={disabled}
              invalid={false}
              onCommit={(value) => write({ leafTarget: value })}
            />
            <p className="text-sm text-muted">
              {"{{words}}"} now: {tokens(summaryWords(resolved.leafTarget))}.
            </p>
            <Origin
              scope={scope}
              from={resolved.from.leafTarget ?? "builtin"}
              same={resolved.leafTarget === Number(fallback.leafTarget ?? LCM_BUILTIN.leafTarget)}
              fallback={tokens(Number(fallback.leafTarget ?? LCM_BUILTIN.leafTarget))}
              disabled={disabled}
              onReset={() => void write({ leafTarget: null })}
            />
          </div>
        </div>
      </details>
    </div>
  )
}
