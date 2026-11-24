// The subagent model chip (spec/SUBAGENTS.md §5.1a; DESIGN §7.10 [D]): beside the model chip
// wherever subagents are allowed in a chat, a multiselect of the models the assistant's
// subagents may use. It follows the model chip's own scope and carry-over rules: a choice is the
// account's, which every chat follows, unless the chat is locked to its own (Lock for this chat,
// the `subagents.models` state key). "Same as this chat's model" tracks the model chip and is the
// default; picks change only when the user changes them. Picking a model is the consent for its
// connection (§5.2), so its row says where subagents may then send what they read.
import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useId, useMemo, useState, useSyncExternalStore } from "react"
import { MAX_PICKS, SAME, SUMMARY, type SubagentSettings } from "@dreamspan/shared/subagents.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Checkbox } from "../../ui/Choice.tsx"
import { Field } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { WindowedList } from "../../ui/WindowedList.tsx"
import { type ModelChoice, useModelChoiceList } from "../chat/modelChoices.ts"
import { ChipText, chipClass, LoadingChip, PopoverRow } from "../chat/nextReplyStrip.tsx"
import type { ChatSession } from "../chat/session.ts"
import { PickerLockRow, PickerPopover, PickerSearch } from "../pickers/PickerParts.tsx"
import { useReplyTools } from "../chat/agent/replyTools.ts"
import { capabilitiesAtom, type WorkshopCapability } from "./capabilities.ts"

/** The capability that allows subagents (agent/capabilities.ts on the server). */
const SUBAGENTS = "subagents"

/** What a change to the account's subagent settings invalidates. */
export const SUBAGENT_SETTINGS_KEY = "subagent-settings"

export const subagentSettingsAtom = AppClient.query(
  "GetSubagentSettings",
  {},
  {
    reactivityKeys: ["settings", SUBAGENT_SETTINGS_KEY]
  }
)

interface SubagentPicksSelection {
  readonly loaded: boolean
  /** The picks in force here: the chat's own while it's locked, else the account's. */
  readonly picks: ReadonlyArray<string>
  readonly settings: SubagentSettings | undefined
  readonly lock?: { readonly locked: boolean; readonly change: (locked: boolean) => void }
  readonly choose: (picks: ReadonlyArray<string>) => Promise<boolean>
  readonly error: ReturnType<typeof useAction>["error"]
}

const noSubscribe = () => () => {}
const noSnapshot = () => null

/** The chip's picks, read and written as the model chip's model is (`useModelSelection`). */
function useSubagentPicks(session: ChatSession | null): SubagentPicksSelection {
  const action = useAction()
  const result = useAtomValue(subagentSettingsAtom)
  const settings = AsyncResult.isSuccess(result) ? result.value : undefined
  const view = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.snapshot ?? noSnapshot)
  const own = view?.cast?.subagentModels
  const locked = own !== undefined
  const picks = own ?? settings?.models.picks ?? []
  return {
    loaded: settings !== undefined && (!session || view?.cast != null),
    picks,
    settings,
    ...(session
      ? {
          lock: {
            locked,
            change: (on: boolean) => void session.changeCast({ _tag: "SubagentModels", picks: on ? [...picks] : null })
          }
        }
      : {}),
    choose: async (next) => {
      if (locked && session) return (await session.changeCast({ _tag: "SubagentModels", picks: [...next] })).ok
      return (
        await action.run(
          (client) => client("ChangeSubagentSettings", { picks: [...next] }),
          ["settings", SUBAGENT_SETTINGS_KEY]
        )
      ).ok
    },
    error: action.error
  }
}

const SAME_LABEL = "Same as this chat's model"
const SUMMARY_LABEL = "This chat's summary model"

/** A pick's name: the two that track the chat, or the model as its lists name it. */
export const pickLabel = (pick: string, choices: ReadonlyArray<ModelChoice>) =>
  pick === SAME
    ? SAME_LABEL
    : pick === SUMMARY
      ? SUMMARY_LABEL
      : (choices.find((c) => c.value === pick)?.label ?? "Model not found")

/** The short name on the chip: "Same model", "Summary model", or the model's name without its connection. */
const shortLabel = (pick: string, choices: ReadonlyArray<ModelChoice>) => {
  if (pick === SAME) return "Same model"
  if (pick === SUMMARY) return "Summary model"
  const label = choices.find((c) => c.value === pick)?.label
  return label ? label.slice(label.indexOf(" · ") + 3) : "Model not found"
}

/** Where subagents may then send what they read (§5.2), said where a model is picked. */
const consent = (choice: ModelChoice | undefined) =>
  `Subagents in your chats may send what they read (your cards, chats or files) to ${choice?.connectionName ?? "this model's connection"}.`

const tracking = [SAME, SUMMARY]

function SubagentModelPicker({
  selection,
  choices,
  focusRef
}: {
  selection: SubagentPicksSelection
  choices: ReadonlyArray<ModelChoice>
  focusRef: React.RefObject<HTMLElement | null>
}) {
  const [query, setQuery] = useState("")
  const listId = useId()
  const { picks } = selection
  const picked = useMemo(() => new Set(picks), [picks])
  const toggle = (pick: string, on: boolean) =>
    void selection.choose(on ? [...picks.filter((p) => p !== pick), pick] : picks.filter((p) => p !== pick))
  const folded = query.trim().toLowerCase()
  // Models not picked yet, to add: the catalog's (a choice's value is "<connection> <model>").
  const addable = useMemo(
    () =>
      choices.filter(
        (c) =>
          c.value.includes(" ") &&
          !c.hidden &&
          !picked.has(c.value) &&
          (folded === "" || c.label.toLowerCase().includes(folded) || (c.modelKey ?? "").toLowerCase().includes(folded))
      ),
    [choices, picked, folded]
  )
  const full = picks.length >= MAX_PICKS
  return (
    <div data-subagent-model-picker="" className="flex min-h-0 flex-col gap-2">
      {selection.lock && (
        <PickerLockRow
          checked={selection.lock.locked}
          disabled={false}
          onCheckedChange={selection.lock.change}
          hint="This chat keeps these subagent models when you change them elsewhere."
        >
          Lock for this chat
        </PickerLockRow>
      )}
      <p className="shrink-0 text-sm text-muted">The assistant picks one of these for each subagent it starts.</p>
      <div role="group" aria-label="Models subagents may use" className="flex shrink-0 flex-col gap-2">
        {[...tracking, ...picks.filter((p) => !tracking.includes(p))].map((pick) => {
          const choice = choices.find((c) => c.value === pick)
          return (
            <Checkbox
              key={pick}
              checked={picked.has(pick)}
              onCheckedChange={(on) => toggle(pick, on)}
              hint={
                pick === SAME
                  ? "Subagents may use the model this chat's replies use."
                  : pick === SUMMARY
                    ? "Subagents may use the model this chat's summaries use, where it isn't the chat's own. Only in chats with summaries on, which already send to it."
                    : picked.has(pick)
                      ? `Subagents may use it. Untick to stop. ${consent(choice)}`
                      : consent(choice)
              }
              description={
                pick === SAME
                  ? undefined
                  : pick === SUMMARY
                    ? "Only where summaries are on"
                    : (choice?.connectionName ?? "Its connection is gone")
              }
            >
              {pickLabel(pick, choices)}
            </Checkbox>
          )
        })}
      </div>
      <Field label="Add a model" labelHidden className="shrink-0">
        <PickerSearch
          label="Add a model"
          placeholder="Add a model: search name or id"
          value={query}
          onChange={setQuery}
          inputRef={focusRef}
          controls={listId}
        />
      </Field>
      <WindowedList
        id={listId}
        items={addable}
        itemKey={(c) => c.value}
        estimateSize={44}
        gap={false}
        className="flex max-h-64 min-h-0 flex-col overflow-y-auto p-2"
        renderItem={(choice) => (
          <Tooltip label={full ? `At most ${MAX_PICKS} models.` : `Lets subagents use it. ${consent(choice)}`}>
            <button
              type="button"
              disabled={full}
              data-subagent-add={choice.value}
              onClick={() => toggle(choice.value, true)}
              className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
            >
              <Icon name="plus" size={14} className="mt-0.5 shrink-0 text-muted" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{choice.label}</span>
            </button>
          </Tooltip>
        )}
      />
      {addable.length === 0 && (
        <p className="shrink-0 text-sm text-muted">
          {folded ? "No other model matches." : "Every model your connections list is picked."}
        </p>
      )}
      <ErrorAlert error={selection.error} />
    </div>
  )
}

/**
 * The chip: "Subagents: Same model", "+2" for more. `session` null in a chat not made yet: the
 * account's picks, which a new chat follows.
 */
function SubagentModelsChip({ session }: { session: ChatSession | null }) {
  const selection = useSubagentPicks(session)
  const navigate = useNavigate()
  const { choices, loaded } = useModelChoiceList(
    true,
    selection.picks.filter((p) => p.includes(" "))
  )
  if (!selection.loaded || !loaded) return <LoadingChip label="Subagent models" />
  const names = selection.picks.map((pick) => shortLabel(pick, choices))
  const text = names.length === 0 ? "None" : names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`
  const full = names.length === 0 ? "none" : selection.picks.map((pick) => pickLabel(pick, choices)).join(", ")
  return (
    <PickerPopover
      title="Subagent models"
      triggerLabel={`Subagent models: ${full}. Change them`}
      hint={
        names.length === 0
          ? "No model is picked for subagents, so the assistant can't start any."
          : `Models the assistant's subagents may use: ${full}`
      }
      triggerClassName={chipClass(names.length === 0 ? "warning" : "neutral")}
      trigger={
        <>
          {selection.lock?.locked && (
            <span role="img" aria-label="Subagent models locked for this chat">
              <Icon name="lock" size={12} />
            </span>
          )}
          <Icon name="tool" size={12} className="text-muted" />
          <ChipText>Subagents: {text}</ChipText>
        </>
      }
      footer={(close) => (
        <PopoverRow
          onClick={() => {
            close()
            void navigate({ to: "/settings/assistant-tools" })
          }}
        >
          Subagent settings…
        </PopoverRow>
      )}
    >
      {({ focusRef }) => <SubagentModelPicker selection={selection} choices={choices} focusRef={focusRef} />}
    </PickerPopover>
  )
}

/** Whether subagents are allowed here: the `subagents` capability isn't Off (spec/SUBAGENTS.md §5.4). */
const subagentsAllowed = (capabilities: ReadonlyArray<WorkshopCapability>) =>
  capabilities.some((c) => c.id === SUBAGENTS && c.mode !== "off")

/** The saved workshop's chip, shown while its `subagents` capability isn't Off. */
export function SavedSubagentModelsChip({ session }: { session: ChatSession }) {
  const result = useAtomValue(capabilitiesAtom(session.chatId))
  if (!AsyncResult.isSuccess(result)) return <LoadingChip label="Subagent models" />
  return subagentsAllowed(result.value) ? <SubagentModelsChip session={session} /> : null
}

/**
 * A story's chip (spec/SUBAGENTS.md §9): shown while its tools are on and allow a tool that starts
 * subagents (the story helper), which is off by default.
 */
export function StorySubagentModelsChip({ session }: { session: ChatSession }) {
  const cast = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const { tools } = useReplyTools(session)
  if (!cast || cast.agentEnabled !== true || !tools) return null
  const allowed = cast.agentTools ?? tools.defaultTools
  return tools.tools.some((t) => t.subagents && allowed.includes(t.id)) ? (
    <SubagentModelsChip session={session} />
  ) : null
}
