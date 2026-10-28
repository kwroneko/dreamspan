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
  summaryWords
} from "@rp/shared/lcmSettings.ts"
import type { LcmSettingsView } from "@rp/shared/lcm.ts"
import { type ReactNode, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Field, Fieldset, Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"

type Resolved = LcmSettingsView["resolved"]
type Misfit = LcmSettingsView["fit"][number]
type Source = "chat" | "account" | "builtin"

const tokens = (n: number) => n.toLocaleString("en-US")

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
      <Button variant="ghost" className="h-7 px-2 text-xs" disabled={disabled} onClick={onReset}>
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
  label,
  value,
  onCommit,
  disabled,
  invalid,
  optional = false
}: {
  label: string
  value: number | null
  onCommit: (value: number | null) => Promise<string | null>
  disabled: boolean
  invalid: boolean
  optional?: boolean
}) {
  const [text, setText] = useState(value === null ? "" : String(value))
  const [problem, setProblem] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  // A new value from the server shows unless something is being typed.
  const [synced, setSynced] = useState(value)
  if (!editing && value !== synced) {
    setSynced(value)
    setText(value === null ? "" : String(value))
  }
  const commit = async () => {
    setEditing(false)
    const trimmed = text.replace(/[,\s_]/g, "")
    if (trimmed === "" && optional) {
      if (value !== null) setProblem(await onCommit(null))
      return
    }
    const n = Number(trimmed)
    if (!Number.isInteger(n) || n <= 0) return setProblem("A whole number of tokens, above 0.")
    if (n === value) return setProblem(null)
    setProblem(await onCommit(n))
  }
  return (
    <Field label={label} error={problem} className="w-36">
      <Input
        inputMode="numeric"
        value={text}
        disabled={disabled}
        placeholder={optional ? "Automatic" : undefined}
        aria-invalid={invalid || problem !== null || undefined}
        onValueChange={(next) => {
          setEditing(true)
          setText(next)
        }}
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
      <Button variant="ghost" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => void onReset()}>
        Reset to {other}
      </Button>
    </span>
  )
}

/** A target and a maximum, with the figure the next context has now. */
function Pair({
  legend,
  description,
  scope,
  resolved,
  fallback,
  target,
  maximum,
  now,
  scaled,
  misfits,
  write,
  disabled
}: {
  legend: string
  description: string
  scope: "chat" | "account"
  resolved: Resolved
  fallback: Partial<Record<LcmField, unknown>>
  target: "recentTarget" | "layerTarget"
  maximum: "recentMax" | "layerMax"
  now: number | null
  scaled: { target: number; maximum: number; clamped: boolean } | null
  misfits: ReadonlyArray<Misfit>
  write: Write
  disabled: boolean
}) {
  const shown = misfits.filter((m) => m.field === target || m.field === maximum)
  // A maximum lowered to the target or below takes the target with it, and says so.
  const [lowered, setLowered] = useState<number | null>(null)
  const commit = async (field: typeof target | typeof maximum, value: number | null) => {
    const below = field === maximum && value !== null ? loweredTarget(resolved[target], resolved[field], value) : null
    const problem = await write(below === null ? { [field]: value } : { [field]: value, [target]: below })
    setLowered(problem === null ? below : null)
    return problem
  }
  return (
    <Fieldset legend={legend} description={description}>
      <div className="flex flex-wrap items-end gap-3">
        {([target, maximum] as const).map((field) => (
          <TokensInput
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
  scope,
  view,
  fallback,
  write,
  disabled,
  instruction
}: {
  scope: "chat" | "account"
  /** The settings as they resolve, the fit and the figures (an account default has no figures). */
  view: Pick<LcmSettingsView, "resolved" | "fit" | "now" | "fitted">
  /** What each field falls back to: the account default for a chat, the built-in for the account. */
  fallback: Partial<Record<LcmField, unknown>>
  write: Write
  disabled: boolean
  /** The instruction's editor, placed after how the request is sent. */
  instruction?: ReactNode
}) {
  const { resolved, fit, now, fitted } = view
  const [problem, setProblem] = useState<{ field: LcmField; message: string } | null>(null)
  const choose = async (change: LcmSettingsChange) => {
    const field = Object.keys(change)[0] as LcmField
    const message = await write(change)
    setProblem(message === null ? null : { field, message })
  }
  const errorFor = (field: LcmField) => (problem?.field === field ? problem.message : null)
  const chunk =
    fitted?.chunk ?? chunkSize(resolved.leafInput, { target: resolved.recentTarget, maximum: resolved.recentMax })
  return (
    <div className="flex flex-col gap-5">
      <Fieldset
        legend="Send with"
        description="The full preset sends the chat as the model sees it with the instruction after it, and reads the chat's cache. Instruction and messages only sends the instruction, the earlier summaries and the messages, like ST's Raw."
      >
        <Segmented
          label="Send with"
          wrap
          value={resolved.withPreset ? "preset" : "raw"}
          onValueChange={(value) => void choose({ withPreset: value === "preset" })}
          options={[
            { value: "preset", label: "The full preset" },
            { value: "raw", label: "Instruction and messages only" }
          ]}
        />
        <Origin
          scope={scope}
          from={resolved.from.withPreset ?? "builtin"}
          same={resolved.withPreset === (fallback.withPreset ?? LCM_BUILTIN.withPreset)}
          fallback={
            (fallback.withPreset ?? LCM_BUILTIN.withPreset) ? "the full preset" : "instruction and messages only"
          }
          disabled={disabled}
          onReset={() => void choose({ withPreset: null })}
        />
        {errorFor("withPreset") && <p className="text-sm text-danger">{errorFor("withPreset")}</p>}
        <Switch
          checked={resolved.withNotes}
          disabled={disabled}
          onCheckedChange={(withNotes) => void choose({ withNotes })}
          description="Off, a summary request sends none of the chat's notes: they can tell of events after the messages it summarizes."
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
      </Fieldset>
      {instruction}
      <Pair
        legend="Recent messages kept as written"
        description="Above the maximum, the oldest are summarized until the recent part is back at the target. Summarizing starts halfway between them, so summaries are usually ready before the maximum."
        scope={scope}
        resolved={resolved}
        fallback={fallback}
        target="recentTarget"
        maximum="recentMax"
        now={now?.recent ?? null}
        scaled={fitted?.recent ?? null}
        misfits={fit}
        write={write}
        disabled={disabled}
      />
      <Pair
        legend="Summary block"
        description="Above the maximum, the oldest summaries are condensed into higher levels until the block is back at the target."
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
      <Fieldset legend="When it runs" description="The total context limit stays with the model's settings.">
        <RadioGroup<LcmWhen>
          value={resolved.when}
          onValueChange={(when) => void choose({ when })}
          options={[
            {
              value: "after-reply",
              label: "Right after a reply, while the cache is warm",
              description: "The summary request reads the reply's cache before it expires."
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
      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-text">Advanced</summary>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <TokensInput
              label="Chunk size"
              value={resolved.leafInput}
              optional
              disabled={disabled}
              invalid={fit.some((m) => m.field === "leafInput")}
              onCommit={(value) => write({ leafInput: value })}
            />
            <p className="text-sm text-muted">
              Tokens of messages one summary covers. Empty is automatic: half the room between the recent target and
              maximum, at most 4,000 (now {tokens(chunk)}).
            </p>
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
              label="Summary length"
              value={resolved.leafTarget}
              disabled={disabled}
              invalid={false}
              onCommit={(value) => write({ leafTarget: value })}
            />
            <p className="text-sm text-muted">
              Tokens per summary. The instruction asks for it in words, about 0.75 a token: its {"{{words}}"} is{" "}
              {tokens(summaryWords(resolved.leafTarget))} now.
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
