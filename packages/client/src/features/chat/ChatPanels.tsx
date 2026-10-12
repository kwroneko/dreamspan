// The chat's side panels: who's in it (DESIGN §2.3, §3.5) and its settings (DATA-MODEL
// §5.3). Every change is a state event at the leaf shown, so it applies from there on, on
// this branch. The context assembler reads the settings; this only writes them.
import type { CastCard, EntityId } from "@rp/shared/chat.ts"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import type { Connection, Model } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import { useEffect, useState } from "react"
import { useAction } from "../../actions.tsx"
import type { AppError } from "../../errors.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Checkbox, RadioGroup, Switch } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { useCast } from "./cast.ts"
import type { ChatSession } from "./session.ts"

function useChange(session: ChatSession) {
  const [error, setError] = useState<AppError | null>(null)
  const change = async (next: CastChange) => {
    const outcome = await session.changeCast(next)
    setError(outcome.ok ? null : outcome.error)
  }
  return { change, error }
}

function Problem({ error }: { error: AppError | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null
}

/** Members: present or absent, played by the user or not, removed; and anyone added. */
export function CastDialog({
  session,
  open,
  onOpenChange
}: {
  session: ChatSession
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { cast, cards } = useCast()
  const { change, error } = useChange(session)
  const action = useAction()
  const [all, setAll] = useState<ReadonlyArray<CastCard>>([])
  useEffect(() => {
    if (!open) return
    void action.run((client) => client("ListCards", undefined)).then((result) => result.ok && setAll(result.value))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open])
  const participants = cast?.participants ?? []
  const playedByMe = cast?.playedByMe ?? []
  const addable = all.filter((card) => !participants.includes(card.entityId))
  const togglePlayed = (id: EntityId, on: boolean) =>
    change({ _tag: "PlayedByMe", entityIds: on ? [...playedByMe, id] : playedByMe.filter((x) => x !== id) })
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Who's here"
      description="Changes apply from the latest message on, on this branch."
    >
      {participants.length === 0 ? (
        <p className="text-sm text-muted">No one has joined this chat.</p>
      ) : (
        <ul aria-label="Members" className="flex flex-col divide-y divide-border">
          {participants.map((id) => {
            const card = cards.get(id)
            const name = card?.name ?? "Unknown card"
            return (
              <li key={id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <Avatar id={id} name={name} />
                  <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                  {card?.persona && <Badge>persona</Badge>}
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${name}`}
                    onClick={() => void change({ _tag: "Leave", entityId: id })}
                  >
                    Remove
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2 pl-10">
                  <Switch
                    checked={!cast!.absent.includes(id)}
                    onCheckedChange={(present) => void change({ _tag: "Presence", entityId: id, present })}
                  >
                    Present
                  </Switch>
                  <Checkbox checked={playedByMe.includes(id)} onCheckedChange={(on) => void togglePlayed(id, on)}>
                    I play them
                  </Checkbox>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {addable.length > 0 && (
        <Field label="Add someone">
          <Select
            items={addable.map((card) => ({
              value: card.entityId,
              label: card.label === card.name ? card.name : `${card.name} (${card.label})`
            }))}
            value={null}
            placeholder="Pick a card"
            onValueChange={(entityId) => void change({ _tag: "Join", entityId })}
          />
        </Field>
      )}
      <Problem error={error ?? action.error} />
      <DialogActions>
        <Button onClick={() => onOpenChange(false)}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}

interface Choices {
  readonly models: ReadonlyArray<{ readonly value: string; readonly label: string }>
  readonly presets: ReadonlyArray<LibraryRef>
}

const modelValue = (connection: string, model: string) => `${connection} ${model}`

/** Model, preset, card layout and role projection for the chat (DESIGN §5.2, §5.4). */
export function SettingsDialog({
  session,
  open,
  onOpenChange
}: {
  session: ChatSession
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { cast } = useCast()
  const { change, error } = useChange(session)
  const action = useAction()
  const [choices, setChoices] = useState<Choices | null>(null)
  useEffect(() => {
    if (!open) return
    void action
      .run((client) =>
        Effect.gen(function* () {
          const connections: ReadonlyArray<Connection> = yield* client("ListConnections", undefined)
          const models = yield* Effect.forEach(connections, (connection) =>
            Effect.map(
              client("ListModels", { connectionId: connection.id, includeHidden: false }),
              (list: ReadonlyArray<Model>) =>
                list.map((model) => ({
                  value: modelValue(connection.id, model.id),
                  label: `${connection.name} · ${model.key}`
                }))
            )
          )
          const presets = yield* client("ListLibrary", { kind: "preset" })
          return { models: models.flat(), presets }
        })
      )
      .then((result) => result.ok && setChoices(result.value))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open])
  const model = cast?.model ? modelValue(cast.model.connection, cast.model.model) : null
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Chat settings"
      description="Changes apply from the latest message on, on this branch."
    >
      <Field
        label="Model"
        description={choices?.models.length === 0 ? "Add a connection with models first." : undefined}
      >
        <Select
          items={choices?.models ?? []}
          value={model}
          placeholder="The default model"
          onValueChange={(value) => {
            const [connection, id] = value.split(" ") as [Connection["id"], Model["id"]]
            void change({ _tag: "Model", connection, model: id })
          }}
        />
      </Field>
      <Field label="Preset" description={choices?.presets.length === 0 ? "Import a preset first." : undefined}>
        <Select
          items={(choices?.presets ?? []).map((preset) => ({ value: preset.id, label: preset.label }))}
          value={cast?.preset ?? null}
          placeholder="The default preset"
          onValueChange={(ref) => void change({ _tag: "Preset", ref })}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span id="layout-label" className="text-sm font-medium">
          Card layout
        </span>
        <RadioGroup
          aria-labelledby="layout-label"
          value={cast?.layoutCards ?? "concat"}
          onValueChange={(layout) => void change({ _tag: "Layout", layout })}
          options={[
            { value: "concat", label: "All cards together", description: "Each card in its own labelled block." },
            {
              value: "swap_tail",
              label: "Speaker's card last",
              description: "The active card goes at the end of the context."
            }
          ]}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span id="roles-label" className="text-sm font-medium">
          Roles
        </span>
        <RadioGroup
          aria-labelledby="roles-label"
          value={cast?.rolesProjection ?? "by_writer"}
          onValueChange={(projection) => void change({ _tag: "Roles", projection })}
          options={[
            { value: "by_writer", label: "By writer", description: "Yours as user, the model's as assistant." },
            { value: "alternate", label: "Alternating", description: "Strictly alternating by position." },
            { value: "perspective", label: "By perspective", description: "The speaker's own turns as assistant." }
          ]}
        />
      </div>
      <Problem error={error ?? action.error} />
      <DialogActions>
        <Button onClick={() => onOpenChange(false)}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}
