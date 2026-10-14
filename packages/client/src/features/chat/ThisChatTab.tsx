// The side panel's "This chat" tab (DESIGN §5.2, §5.4, §8; DATA-MODEL §5.3, §5.4): what the
// next reply is sent with, each with its value and where it comes from, and the chat's own
// settings. A change is a state event at the leaf shown, so from there on, on this branch.
// The context assembler reads them; this only writes them.
import type { EffectivePreset } from "@rp/shared/inspectorApi.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import type { Connection, Model } from "@rp/shared/providers.ts"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { Link } from "@tanstack/react-router"
import { Effect } from "effect"
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { useCast } from "./cast.ts"
import { EnableLcmDialog } from "./EnableLcmDialog.tsx"
import { modelValue, parseModelValue } from "./modelChoices.ts"
import type { ChatSession } from "./session.ts"

const link = "text-accent hover:underline"

interface Sources {
  readonly connections: ReadonlyArray<Connection>
  /** Every visible model, by `modelValue`. */
  readonly models: ReadonlyMap<string, { readonly connection: Connection; readonly model: Model }>
  readonly presets: ReadonlyArray<LibraryRef>
}

function Problem({ error }: { error: AppError | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null
}

/** One thing the chat sends with: its value in effect, where that comes from, and how to change it. */
function Setting({
  title,
  value,
  source,
  children
}: {
  title: string
  value: ReactNode
  source: ReactNode
  children?: ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{title}</h3>
        <p className="font-medium [overflow-wrap:anywhere]" data-testid={`${title.toLowerCase()}-in-effect`}>
          {value}
        </p>
        <p className="text-sm text-muted">{source}</p>
      </div>
      {children}
    </section>
  )
}

/**
 * The model as the server resolved it for the next reply (`GetNextContext` and `Cache`), so a
 * change made anywhere (another tab, Settings, a connection renamed) shows before a send uses it.
 */
function ModelSetting({
  session,
  sources,
  change
}: {
  session: ChatSession
  sources: Sources | null
  change: (next: CastChange) => Promise<void>
}) {
  const effective = useSyncExternalStore(session.subscribe, session.snapshot).history?.model
  // Only visible models are offered; a hidden one in use is still named above.
  const items = [...(sources?.models.entries() ?? [])].map(([value, { connection, model }]) => ({
    value,
    label: `${connection.name} · ${model.key}`
  }))
  const gone = effective != null && (effective.connectionName === null || effective.modelKey === null)
  let value: ReactNode
  let source: ReactNode
  if (effective === undefined) {
    value = "…"
    source = "Worked out with the next reply's context."
  } else if (effective === null) {
    value = "None"
    source = (
      <>
        No model is set in this chat and you have no default, so replies can't be generated.{" "}
        {sources?.connections.length === 0 ? (
          <Link to="/settings/connections" className={link}>
            Add a connection
          </Link>
        ) : (
          <>
            Pick one below, or set a default in{" "}
            <Link to="/settings/chats" className={link}>
              Settings → Chats
            </Link>
          </>
        )}
        .
      </>
    )
  } else if (gone) {
    value = "A model that's gone"
    source =
      effective.scope === "chat"
        ? "Set in this chat, but its connection or the model was deleted. Choose another."
        : "Your default, but its connection or the model was deleted. Choose another."
  } else {
    value = `${effective.connectionName} · ${effective.modelKey}`
    source = (
      <>
        {effective.scope === "chat" ? (
          "Set in this chat."
        ) : (
          <>
            Your default model, from{" "}
            <Link to="/settings/chats" className={link}>
              Settings → Chats
            </Link>
            .
          </>
        )}
        {effective.hidden && (
          <span className="block">
            It's hidden in Connections, so it isn't offered in model lists, but this chat still uses it.
          </span>
        )}
      </>
    )
  }
  const picked = effective ? modelValue(effective.connection, effective.model) : null
  return (
    <Setting title="Model" value={value} source={source}>
      {items.length > 0 && (
        <Field label="Use in this chat" description="From the latest message on, on this branch.">
          <Select
            items={items}
            value={picked !== null && sources?.models.has(picked) ? picked : null}
            placeholder="Choose a model"
            onValueChange={(next) => void change({ _tag: "Model", ...parseModelValue(next) })}
          />
        </Field>
      )}
    </Setting>
  )
}

const presetSource = (preset: EffectivePreset, connection: string | null): ReactNode => {
  switch (preset.scope) {
    case "chat":
      return "Set in this chat."
    case "role":
      return "Set for this chat's role."
    case "connection":
      return connection
        ? `The preset of the connection “${connection}”, which overrides your default.`
        : "The preset of the model's connection, which overrides your default."
    case "user":
      return (
        <>
          Your default preset, from{" "}
          <Link to="/settings/chats" className={link}>
            Settings → Chats
          </Link>
          .
        </>
      )
    case "builtin":
      return "SillyTavern's built-in default: no preset is set in this chat, on its connection or as your default."
  }
}

function PresetSetting({
  session,
  sources,
  change
}: {
  session: ChatSession
  sources: Sources | null
  change: (next: CastChange) => Promise<void>
}) {
  const { cast } = useCast()
  const history = useSyncExternalStore(session.subscribe, session.snapshot).history
  const preset = history?.preset ?? null
  const budget = history?.budget ?? null
  const connection = history?.model?.connectionName ?? null
  const name = preset === null ? "…" : preset.scope === "builtin" ? "SillyTavern's default preset" : preset.name
  const items = (sources?.presets ?? []).map((ref) => ({ value: ref.id as string, label: ref.label }))
  const value = cast?.preset ?? (preset?.scope === "builtin" ? null : (preset?.ref ?? null))
  return (
    <Setting
      title="Preset"
      value={name}
      source={
        <>
          {preset === null ? "Worked out with the next reply's context." : presetSource(preset, connection)}
          {budget && (
            <span className="block">
              Context: {budget.maximum.toLocaleString()} tokens, {budget.responseReserve.toLocaleString()} of them for
              the reply.
            </span>
          )}
          {preset?.ref && (
            <Link to="/library/$refId" params={{ refId: preset.ref }} className={`block ${link}`}>
              Open “{preset.name}” in the editor
            </Link>
          )}
        </>
      }
    >
      {items.length > 0 ? (
        <Field label="Use in this chat" description="From the latest message on, on this branch.">
          <Select
            items={items}
            value={value}
            placeholder="SillyTavern's default preset"
            onValueChange={(ref) => void change({ _tag: "Preset", ref: ref as LibraryRef["id"] })}
          />
        </Field>
      ) : (
        sources !== null && (
          <p className="text-sm text-muted">
            Import a preset in the{" "}
            <Link to="/library" className={link}>
              library
            </Link>{" "}
            to choose one.
          </p>
        )
      )}
    </Setting>
  )
}

/**
 * LCM for the whole chat (DESIGN §8): on for new chats, off for imported ones. Turning it on
 * for a chat with messages asks how to start and what it costs first (spec/LCM.md §2.7, §2.11).
 */
function SummariesSetting({ session }: { session: ChatSession }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const [error, setError] = useState<AppError | null>(null)
  const [enabling, setEnabling] = useState(false)
  const enabled = view.lcm?.enabled ?? false
  return (
    <section aria-label="Summaries" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Summaries</h3>
      <Switch
        checked={enabled}
        onCheckedChange={(on) => {
          if (on && view.leafSlotId !== null) return setEnabling(true)
          void session
            .call((client) => client("SetLcmEnabled", { chatId: session.id, enabled: on }))
            .then((result) => setError(result.ok ? null : result.error))
        }}
        description="Older messages are summarized so the chat can go on. For the whole chat, not from here on. Nothing is generated until your next reply."
      >
        Summarize older messages
      </Switch>
      {enabling && <EnableLcmDialog session={session} onOpenChange={setEnabling} />}
      <Problem error={error} />
    </section>
  )
}

export function ThisChatTab({ session, active }: { session: ChatSession; active: boolean }) {
  const { cast } = useCast()
  const action = useAction()
  const [error, setError] = useState<AppError | null>(null)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  const [sources, setSources] = useState<Sources | null>(null)
  // The lists to choose from, read again each time the tab is shown.
  useEffect(() => {
    if (!active) return
    void action
      .run((client) =>
        Effect.gen(function* () {
          const connections: ReadonlyArray<Connection> = yield* client("ListConnections", undefined)
          const lists = yield* Effect.forEach(connections, (connection) =>
            Effect.map(
              client("ListModels", { connectionId: connection.id, includeHidden: false }),
              (list: ReadonlyArray<Model>) =>
                list.map((model) => [modelValue(connection.id, model.id), { connection, model }] as const)
            )
          )
          const presets = yield* client("ListLibrary", { kind: "preset" })
          return { connections, models: new Map(lists.flat()), presets }
        })
      )
      .then((result) => result.ok && setSources(result.value))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each time it's shown
  }, [active])
  const multi = (cast?.participants.length ?? 0) > 1
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        What the next reply is sent with, and where each comes from. Changes here apply from the latest message on, on
        this branch.
      </p>
      <ModelSetting session={session} sources={sources} change={change} />
      <PresetSetting session={session} sources={sources} change={change} />
      <SummariesSetting session={session} />
      <section aria-label="Card layout" className="flex flex-col gap-2">
        <h3 id="layout-label" className="text-xs font-medium tracking-wide text-muted uppercase">
          Card layout
        </h3>
        <p className="text-sm text-muted">
          Where the members' cards go in what's sent{multi ? "" : "; it matters once a chat has several characters"}.
        </p>
        <RadioGroup
          aria-labelledby="layout-label"
          value={cast?.layoutCards ?? "concat"}
          onValueChange={(layout) => void change({ _tag: "Layout", layout })}
          options={[
            {
              value: "concat",
              label: "All cards together",
              description: "Every character's card, each in its own labelled block where the preset puts the card."
            },
            {
              value: "swap_tail",
              label: "Speaker's card last",
              description: "Only the replying character's card, at the end of the context, as ST's card swap does."
            }
          ]}
        />
      </section>
      <section aria-label="Roles" className="flex flex-col gap-2">
        <h3 id="roles-label" className="text-xs font-medium tracking-wide text-muted uppercase">
          Roles
        </h3>
        <p className="text-sm text-muted">Which messages are sent as the user's and which as the model's.</p>
        <RadioGroup
          aria-labelledby="roles-label"
          value={cast?.rolesProjection ?? "by_writer"}
          onValueChange={(projection) => void change({ _tag: "Roles", projection })}
          options={[
            { value: "by_writer", label: "By writer", description: "Yours as user, the model's as assistant." },
            {
              value: "alternate",
              label: "Alternating",
              description: "Strictly alternating by position, for models that require it."
            },
            {
              value: "perspective",
              label: "By perspective",
              description: "The replying character's own turns as assistant, everyone else's as user."
            }
          ]}
        />
      </section>
      <p className="text-sm text-muted">
        The refusal judge, the fallback summarizer and the default summarization instruction apply to all your chats:
        they're in{" "}
        <Link to="/settings/chats" className={link}>
          Settings → Chats
        </Link>
        .
      </p>
      <Problem error={error ?? action.error} />
    </div>
  )
}
